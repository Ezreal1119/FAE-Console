import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import ssh2 from 'ssh2';
import { RequestError } from './store.mjs';

const directories = new Map([
  ['requirement', 'requirements'], ['delivery', 'deliverables'], ['project', 'projects'], ['legacy', 'legacy']
]);
const missingFile = error => error.code === 2;
const sftpCall = (sftp, method, ...args) => new Promise((resolve, reject) => {
  sftp[method](...args, (error, value) => error ? reject(error) : resolve(value));
});

const downloadChunkSize = 32 * 1024;
const downloadReadAhead = 4;

async function readChunk(sftp, handle, offset, length) {
  const chunk = Buffer.allocUnsafe(length);
  for (let filled = 0; filled < length;) {
    const count = await sftpCall(sftp, 'read', handle, chunk, filled, length - filled, offset + filled);
    if (!count) throw new Error('附件在读取完成前结束。');
    filled += count;
  }
  return chunk;
}

async function* downloadChunks(sftp, handle, size, signal) {
  // Keep a small SFTP read window in flight, yielding in file order as HTTP drains.
  const pending = [];
  let offset = 0;
  while (pending.length || offset < size) {
    signal.throwIfAborted();
    while (pending.length < downloadReadAhead && offset < size) {
      const length = Math.min(downloadChunkSize, size - offset);
      pending.push(readChunk(sftp, handle, offset, length).then(chunk => ({ chunk }), error => ({ error })));
      offset += length;
    }
    const { chunk, error } = await pending.shift();
    if (error) throw error;
    yield chunk;
  }
}

export function openSftpStorage(settings) {
  const { SFTP_HOST: host, SFTP_PORT, SFTP_USERNAME: username, SFTP_PASSWORD: password,
    SFTP_HOST_FINGERPRINT: fingerprint, SFTP_ROOT = '/FAE-Console', SFTP_LEGACY_SSH } = settings;
  const port = Number(SFTP_PORT || 22);
  const root = posix.normalize(SFTP_ROOT);
  if (host && (!username || !password || !/^SHA256:[A-Za-z0-9+/]{43}$/.test(fingerprint ?? '') ||
      !Number.isInteger(port) || port < 1 || port > 65535 || !root.startsWith('/') || root === '/')) {
    throw new Error('附件 SFTP 配置不完整或格式错误。');
  }

  function remotePath(file) {
    if (!directories.has(file.kind) || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(file.id)) {
      throw new Error('附件存储索引无效。');
    }
    return posix.join(root, directories.get(file.kind), file.id);
  }

  async function withSftp(operation, requestSignal) {
    if (!host) throw new RequestError(503, '附件存储暂不可用，请稍后重试。');
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(6 * 60_000),
      ...(requestSignal ? [requestSignal] : [])]);
    signal.throwIfAborted();
    const client = new ssh2.Client();
    let interrupt;
    const failure = new Promise((_, reject) => {
      interrupt = () => {
        reject(signal.reason);
        client.destroy();
      };
      signal.addEventListener('abort', interrupt, { once: true });
    });
    client.on('error', error => controller.abort(error));
    client.once('close', () => controller.abort(new Error('SFTP 连接已关闭。')));

    try {
      const connection = new Promise((resolve, reject) => {
        client.once('ready', () => client.sftp((error, sftp) => error ? reject(error) : resolve(sftp)));
        client.connect({
          host, port, username, password, readyTimeout: 10_000, keepaliveInterval: 15_000,
          hostVerifier: key => 'SHA256:' + createHash('sha256').update(key).digest('base64').replace(/=$/, '') === fingerprint,
          algorithms: SFTP_LEGACY_SSH === '1' ? { kex: { append: ['diffie-hellman-group14-sha1'] } } : undefined
        });
      });
      return await Promise.race([failure, connection.then(sftp => {
        signal.throwIfAborted();
        return operation(sftp, signal);
      })]);
    } catch (error) {
      if (error instanceof RequestError || requestSignal?.aborted) throw error;
      console.error('附件 SFTP 操作失败：', error.code ?? error.level ?? error.name);
      throw new RequestError(503, '附件存储暂不可用，请稍后重试。');
    } finally {
      signal.removeEventListener('abort', interrupt);
      client.end();
    }
  }

  return {
    prepare() {
      return withSftp(async sftp => {
        for (const path of [root, ...[...directories.values()].map(name => posix.join(root, name))]) {
          try {
            const stat = await sftpCall(sftp, 'lstat', path);
            if (!stat.isDirectory()) throw new Error('附件 SFTP 目录无效。');
          } catch (error) {
            if (!missingFile(error)) throw error;
            await sftpCall(sftp, 'mkdir', path);
          }
        }
      });
    },

    put(file, source, signal) {
      return withSftp(async (sftp, transferSignal) => {
        const path = remotePath(file);
        let handle;
        try {
          handle = await sftpCall(sftp, 'open', path, 'wx', 0o600);
        } catch (error) {
          if (!missingFile(error)) throw error;
          try { await sftpCall(sftp, 'mkdir', posix.dirname(path)); } catch {}
          handle = await sftpCall(sftp, 'open', path, 'wx', 0o600);
        }
        // Finish the writes before waiting for the server to acknowledge CLOSE.
        const output = sftp.createWriteStream(path, { handle, autoClose: false });
        await pipeline(source, output, { signal: transferSignal });
        await sftpCall(sftp, 'close', handle);
      }, signal);
    },

    read(file, consume, signal) {
      return withSftp(async (sftp, transferSignal) => {
        const path = remotePath(file);
        let handle;
        try { handle = await sftpCall(sftp, 'open', path, 'r'); }
        catch (error) {
          if (missingFile(error)) throw new RequestError(404, '存储中找不到这份文件。');
          throw error;
        }
        const stat = await sftpCall(sftp, 'fstat', handle);
        if (stat.size !== file.size) throw new Error('附件大小与索引不一致。');
        const stream = Readable.from(downloadChunks(sftp, handle, file.size, transferSignal), {
          objectMode: false, highWaterMark: downloadChunkSize
        });
        const result = await consume(stream, transferSignal);
        await sftpCall(sftp, 'close', handle);
        return result;
      }, signal);
    },

    remove(file) {
      return withSftp(async sftp => {
        try { await sftpCall(sftp, 'unlink', remotePath(file)); }
        catch (error) {
          if (!missingFile(error)) throw error;
        }
      });
    }
  };
}

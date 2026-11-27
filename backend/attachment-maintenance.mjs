import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { openSftpStorage } from './sftp-storage.mjs';
import { openStore } from './store.mjs';

async function hash(chunks) {
  const digest = createHash('sha256');
  for await (const chunk of chunks) digest.update(chunk);
  return digest.digest('hex');
}

async function filesOnDisk(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (entries.some(entry => !entry.isFile())) throw new Error('旧附件目录包含非文件条目，请先核对。');
    return new Set(entries.map(entry => entry.name));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return new Set();
  }
}

async function verify(storage, file, path) {
  const expected = await hash(createReadStream(path));
  const actual = await storage.read(file, hash);
  if (expected !== actual) throw new Error('SFTP 文件校验失败：' + file.id);
}

async function migrate(storage, store, purge) {
  const db = store.read();
  const local = await filesOnDisk(store.attachments);
  const tasks = new Map(db.tasks.map(task => [task.id, task]));
  const indexed = new Set(db.attachments.map(file => file.id));
  if ([...local].some(id => !indexed.has(id))) throw new Error('有未登记的旧附件，请先核对。');
  const legacy = new Map();

  for (const old of db.attachments) {
    if (old.state) {
      if (old.kind === 'legacy' && local.has(old.id)) {
        if (old.state !== 'bound') throw new Error('历史附件状态无效：' + old.id);
        legacy.set(old.id, old);
      }
      continue;
    }
    if (old.task_id === null) continue;
    if (purge) throw new Error('请先完成旧附件迁移。');
    const task = tasks.get(old.task_id);
    if (task?.attachment_path !== old.id || !local.has(old.id)) {
      throw new Error('旧附件与任务或本地文件不一致：' + old.id);
    }
    const path = join(store.attachments, old.id);
    const { size } = await lstat(path);
    const file = { ...old, kind: 'legacy', name: task.attachment_name || '历史附件', size, state: 'bound' };
    // A previous migration may have stopped before committing the index.
    await storage.remove(file);
    await storage.put(file, () => createReadStream(path));
    await verify(storage, file, path);
    legacy.set(file.id, file);
  }

  if (purge) {
    for (const name of local) {
      const file = legacy.get(name);
      const pending = db.attachments.find(row => row.id === name && !row.state && row.task_id === null);
      if (!file && !pending) throw new Error('拒绝清理无法验证的本地文件：' + name);
      if (file) await verify(storage, file, join(store.attachments, name));
    }
    for (const name of local) await unlink(join(store.attachments, name));
    if (db.attachments.some(file => !file.state && file.task_id === null)) {
      store.update(next => { next.attachments = next.attachments.filter(file => file.state || file.task_id !== null); });
    }
  } else if (legacy.size) {
    store.update(next => { next.attachments = next.attachments.map(file => legacy.get(file.id) ?? file); });
  }
  console.log(purge ? '已清理本地旧附件 ' + local.size + ' 个。' : '已校验历史附件 ' + legacy.size + ' 个。');
}

const [operation, directory] = process.argv.slice(2);
const storage = openSftpStorage(process.env);
if (operation === 'prepare') {
  await storage.prepare();
  console.log('SFTP 附件目录已就绪。');
} else if (directory && ['migrate', 'purge'].includes(operation)) {
  await migrate(storage, openStore(directory), operation === 'purge');
} else {
  throw new Error('用法：attachment-maintenance.mjs prepare | migrate <DATA_DIR> | purge <DATA_DIR>');
}

import { randomUUID } from 'node:crypto';
import { RequestError } from './store.mjs';

export const attachmentLimit = 50 * 1024 * 1024;
const batchLimit = 12;
const expiry = 24 * 60 * 60 * 1000;
const kinds = new Set(['requirement', 'delivery', 'project']);
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export function attachmentKind(kind) {
  if (!kinds.has(kind)) throw new RequestError(400, '文件类型无效，请刷新页面后重试。');
  return kind;
}

export function bindAttachments(db, user, target, kind, files = [], { targetKey = 'task_id', extra = {} } = {}) {
  if (!Array.isArray(files) || files.length > batchLimit) {
    throw new RequestError(400, '每次最多添加 12 个文件。');
  }
  if (!files.length) return;
  const uploaded = new Map(db.attachments.map(row => [row.id, row]));
  const ids = new Set();
  for (const item of files) {
    const { id, name } = item ?? {};
    if (typeof id !== 'string' || !uuid.test(id) || ids.has(id) ||
        typeof name !== 'string' || !name.trim() || name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(name)) {
      throw new RequestError(400, '文件名称或编号无效。');
    }
    ids.add(id);
    const file = uploaded.get(id);
    if (file?.kind === kind && file.uploaded_by === user.id) {
      if (file.state === 'bound' && file[targetKey] === target.id && file.name === name) continue;
      if (file.state === 'pending' && file.created_at > Date.now() - expiry) {
        Object.assign(file, { state: 'bound', [targetKey]: target.id, name, ...extra });
        continue;
      }
    }
    throw new RequestError(400, '文件已过期或不可用，请重新选择并上传。');
  }
}

export function openAttachments(store, storage) {
  const uploads = new Set();
  let cleaning = false;
  let cleanupRequested = false;

  async function cleanup() {
    if (cleaning) {
      cleanupRequested = true;
      return;
    }
    cleaning = true;
    try {
      // Startup can encounter an upload interrupted by a process restart.
      const abandoned = store.read().attachments.filter(row => (
        row.state === 'uploading' && !uploads.has(row.uploaded_by) ||
        row.state === 'pending' && row.created_at <= Date.now() - expiry
      ));
      if (abandoned.length) {
        const ids = new Set(abandoned.map(file => file.id));
        store.update(db => {
          for (const file of db.attachments) if (ids.has(file.id)) file.state = 'deleting';
        });
      }
      for (const file of store.read().attachments.filter(row => row.state === 'deleting')) {
        try {
          await storage.remove(file);
          store.update(db => { db.attachments = db.attachments.filter(row => row.id !== file.id); });
        } catch (error) {
          console.error('附件清理待重试：', error.code ?? error.name);
        }
      }
    } catch (error) {
      console.error('附件清理待重试：', error.code ?? error.name);
    } finally {
      cleaning = false;
      if (cleanupRequested) {
        cleanupRequested = false;
        void cleanup();
      }
    }
  }

  void cleanup();
  setInterval(cleanup, 60 * 60 * 1000).unref();

  return {
    cleanup,
    discard(user, { ids }) {
      if (!Array.isArray(ids) || ids.length > batchLimit || ids.some(id => typeof id !== 'string' || !uuid.test(id))) {
        throw new RequestError(400, '文件编号无效。');
      }
      const selected = new Set(ids);
      store.update(db => {
        for (const file of db.attachments) {
          if (file.state === 'pending' && file.uploaded_by === user.id && selected.has(file.id)) file.state = 'deleting';
        }
      });
      void cleanup();
      return {};
    },

    async upload(user, kind, req, signal, authorize) {
      attachmentKind(kind);
      const declared = req.headers['content-length'];
      if (Number(declared) > attachmentLimit) throw new RequestError(413, '单个文件最多 50 MB。');
      if (declared === '0') throw new RequestError(400, '请选择非空文件。');
      if (uploads.size >= 4 || uploads.has(user.id)) {
        throw new RequestError(429, '正在上传文件，请稍后重试。');
      }

      const file = { id: randomUUID(), task_id: null, kind, uploaded_by: user.id, created_at: Date.now(), state: 'uploading' };
      let size = 0;
      let ready = false;
      async function* body() {
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
          size += chunk.length;
          if (size > attachmentLimit) throw new RequestError(413, '单个文件最多 50 MB。');
          yield chunk;
        }
        if (!size) throw new RequestError(400, '请选择非空文件。');
      }

      if (store.read().attachments.filter(row => row.uploaded_by === user.id &&
          row.state === 'pending' && row.created_at > Date.now() - expiry).length >= batchLimit) {
        throw new RequestError(429, '待保存的文件过多，请先保存上一批。');
      }
      uploads.add(user.id);
      try {
        store.update(db => { db.attachments.push(file); });
        await storage.put(file, body, signal);
        signal.throwIfAborted();
        authorize();
        store.update(db => {
          const row = db.attachments.find(item => item.id === file.id);
          Object.assign(row, { size, state: 'pending' });
        });
        ready = true;
        return { id: file.id };
      } finally {
        uploads.delete(user.id);
        if (!ready) {
          try {
            if (store.read().attachments.some(row => row.id === file.id)) {
              store.update(db => { db.attachments.find(row => row.id === file.id).state = 'deleting'; });
            }
          } finally {
            void cleanup();
          }
        }
      }
    }
  };
}

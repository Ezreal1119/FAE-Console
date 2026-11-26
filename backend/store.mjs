import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const demandOptionKinds = ['proj', 'proposer'];
const defaultTaskOptions = {
  category: [
    '样机组装与改制', '调试改料与返工', '试产与量产导入', '测试与验证',
    '工装治具', '技术资料与 SOP', '质量异常与客诉', '技术支持'
  ],
  device_type: ['POS', 'PDA', '手柄', '扫描头', '座充与底座', '扫描枪', '穿戴设备'],
  project_stage: ['立项', 'EVT', 'DVT', 'PVT', 'MP']
};
const taskOptionKinds = Object.keys(defaultTaskOptions);
const validOptionList = list => Array.isArray(list) && list.every(value => typeof value === 'string');

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function openStore(directory) {
  const file = join(directory, 'db.json');
  const attachments = join(directory, 'attachments');
  mkdirSync(attachments, { recursive: true, mode: 0o700 });

  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
    const collections = ['users', 'profiles', 'tasks', 'demands', 'sessions', 'attachments'];
    if (data?.version !== 1 || collections.some(key => !Array.isArray(data[key])) ||
        ['user', 'profile', 'task', 'demand'].some(key => !Number.isSafeInteger(data.seq?.[key]) || data.seq[key] < 1)) {
      throw new Error('数据库结构无效：' + file);
    }
    if (Object.hasOwn(data, 'demandOptions') &&
        (demandOptionKinds.some(key => !validOptionList(data.demandOptions?.[key])) ||
         taskOptionKinds.some(key => Object.hasOwn(data.demandOptions, key) && !validOptionList(data.demandOptions[key])))) {
      throw new Error('基础配置选项结构无效：' + file);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = {
      version: 1, users: [], profiles: [], tasks: [], demands: [], sessions: [], attachments: [],
      demandOptions: { proj: [], proposer: [], ...structuredClone(defaultTaskOptions) },
      seq: { user: 1, profile: 1, task: 1, demand: 1 }
    };
  }

  // One process owns this store. Publish the in-memory change only after the atomic replacement.
  function update(change) {
    const next = structuredClone(data);
    const result = change(next);
    const temp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
    try {
      writeFileSync(temp, JSON.stringify(next, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
      renameSync(temp, file);
    } catch (error) {
      if (error.code !== 'EEXIST') {
        try { unlinkSync(temp); }
        catch (cleanupError) {
          if (cleanupError.code !== 'ENOENT') console.error('清理数据库临时文件失败：', cleanupError.code);
        }
      }
      throw error;
    }
    data = next;
    return result;
  }

  const missingOptions = taskOptionKinds.filter(key => !Object.hasOwn(data.demandOptions ?? {}, key));
  if (missingOptions.length) {
    update(db => {
      db.demandOptions ??= Object.fromEntries(demandOptionKinds.map(key => {
        const names = db.demands.map(row => typeof row[key] === 'string' ? row[key].trim() : '').filter(Boolean);
        return [key, [...new Set(names)]];
      }));
      for (const key of missingOptions) db.demandOptions[key] = [...defaultTaskOptions[key]];
    });
  }

  return { read: () => data, update, attachments };
}

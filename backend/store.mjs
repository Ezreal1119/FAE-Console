import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const demandOptionKinds = ['proj', 'proposer'];
const defaultProjects = [
  'SQ16', 'SQ27L', 'SQ27M', 'SQ27MB', 'SQ27TGW', 'SQ28W', 'SQ29', 'SQ29HM', 'SQ29M', 'SQ29MB', 'SQ29MR', 'SQ35',
  'SQ45', 'SQ45S', 'SQ45T', 'SQ46', 'SQ46S', 'SQ47', 'SQ47PRO', 'SQ47S', 'SQ48', 'SQ48C', 'SQ48S',
  'SQ51', 'SQ51Q', 'SQ53', 'SQ53B', 'SQ53D', 'SQ53H', 'SQ53P', 'SQ53PRO', 'SQ53R', 'SQ53S', 'SQ53ST', 'SQ53X',
  'SQ53XC', 'SQ58', 'SQ58C', 'SQ58H', 'SQ58PRO',
  'SQ65', 'SQ65A', 'SQ65B', 'SQ65E', 'SQ65F', 'SQ65FS', 'SQ65FSQ', 'SQ65FU', 'SQ66',
  'SQ68', 'SQ68MB', 'SQ68MINI', 'SQ68P', 'SQ68PN',
  'SQ69', 'SQ69B', 'SQ69BMP', 'SQ69BX', 'SQ69BXP', 'SQ69D', 'SQ69DM', 'SQ69DMP', 'SQ69DX', 'SQ69DXP', 'SQ69MINI', 'SQ69PC',
  'SQ81', 'SQ83', 'SQ83A', 'SQ83S', 'SQ86', 'SQ91', 'SQ91-610', 'SQ92', 'SQ92P',
  'SQ310', 'SQ510', 'SQ610', 'SQ610PRO', 'SQ610XC', 'SQ630', 'SQ630P'
];
const defaultProjectNames = new Set(defaultProjects);
const defaultTaskOptions = {
  device_type: ['POS', 'PDA', '手柄', '扫描头', '座充与底座', '扫描枪', '穿戴设备'],
  project_stage: ['立项', 'EVT', 'DVT', 'PVT', 'MP'],
  project_manager: []
};
const taskOptionKinds = Object.keys(defaultTaskOptions);
const validOptionList = list => Array.isArray(list) && list.every(value => typeof value === 'string');

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function readDatabase(file) {
  const data = JSON.parse(readFileSync(file, 'utf8'));
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
  return data;
}

export function openStore(directory) {
  const file = join(directory, 'db.json');
  const attachments = join(directory, 'attachments');
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  let data;
  try {
    data = readDatabase(file);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    data = {
      version: 1, users: [], profiles: [], tasks: [], demands: [], sessions: [], attachments: [],
      demandOptions: { proj: [...defaultProjects], proposer: [], ...structuredClone(defaultTaskOptions) },
      projectPresetsSeeded: true,
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
  const needsProjectPresets = data.projectPresetsSeeded !== true;
  if (missingOptions.length || needsProjectPresets) {
    update(db => {
      db.demandOptions ??= Object.fromEntries(demandOptionKinds.map(key => {
        const names = db.demands.map(row => typeof row[key] === 'string' ? row[key].trim() : '').filter(Boolean);
        return [key, [...new Set(names)]];
      }));
      for (const key of missingOptions) db.demandOptions[key] = [...defaultTaskOptions[key]];
      if (needsProjectPresets) {
        const projects = db.demandOptions.proj.map(name => {
          const canonical = name.normalize('NFKC').trim().toUpperCase().replace(/\s+(?=(?:PRO|MINI|S)$)/, '');
          return defaultProjectNames.has(canonical) ? canonical : name;
        });
        db.demandOptions.proj = [...new Set([...projects, ...defaultProjects])];
        db.projectPresetsSeeded = true;
      }
    });
  }

  return { read: () => data, update, attachments };
}

import { randomUUID } from 'node:crypto';
import { RequestError } from './store.mjs';

const stages = ['EVT', 'DVT', 'PVT', 'MP'];

function cleanRequirement(input) {
  const { description, deliverable, planned_hours: hours } = input ?? {};
  if (typeof description !== 'string' || typeof deliverable !== 'string' ||
      description.length > 10000 || deliverable.length > 10000) {
    throw new RequestError(400, '需求说明和交付内容均须在 10000 字以内。');
  }
  if (!description.trim() && !deliverable.trim()) throw new RequestError(400, '请填写需求说明或交付内容。');
  if (hours !== null && (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0)) {
    throw new RequestError(400, '请输入有效的计划投入工时。');
  }
  return { description: description.trim(), deliverable: deliverable.trim(), planned_hours: hours };
}

function storedRequirements(db, name) {
  const projects = db.projectRequirements ?? {};
  return Object.hasOwn(projects, name) ? projects[name] : null;
}

function appendRequirement(stage, list, fields) {
  const code = `${stage}-${String(list.next++).padStart(3, '0')}`;
  list.rows.push({ code, ...fields, revision: randomUUID() });
}

export function initializeProjectRequirements(db, name, template = db.projectRequirementTemplate) {
  const lists = storedRequirements(db, name) ?? Object.fromEntries(stages.map(stage => [stage, { next: 1, rows: [] }]));
  for (const stage of stages) {
    for (const fields of template?.[stage] ?? []) appendRequirement(stage, lists[stage], fields);
  }
  db.projectRequirements = { ...db.projectRequirements, [name]: lists };
  return lists;
}

export function seedProjectRequirements(store, seed) {
  if (store.read().projectRequirementTemplate) return;
  if (!seed || stages.some(stage => !Array.isArray(seed[stage]) || !seed[stage].length)) {
    throw new Error('NPI 阶段种子数据应包含 EVT、DVT、PVT、MP 四组需求。');
  }
  const template = Object.fromEntries(stages.map(stage => [stage, seed[stage].map(cleanRequirement)]));
  store.update(db => {
    db.projectRequirementTemplate = template;
    for (const name of db.demandOptions.proj) initializeProjectRequirements(db, name, template);
  });
}

export function projectRequirementRows(db, name) {
  const lists = storedRequirements(db, name);
  return Object.fromEntries(stages.map(stage => [stage, lists?.[stage].rows ?? []]));
}

export function changeProjectRequirement(db, { name, stage, action, code, revision, ...fields }) {
  if (!db.demandOptions.proj.includes(name)) throw new RequestError(404, '未找到此项目。');
  if (!stages.includes(stage) || !['add', 'update', 'remove'].includes(action)) {
    throw new RequestError(400, '项目阶段或需求操作无效。');
  }
  const lists = storedRequirements(db, name) ?? initializeProjectRequirements(db, name);
  const list = lists[stage];
  if (action === 'add') {
    appendRequirement(stage, list, cleanRequirement(fields));
  } else {
    const index = list.rows.findIndex(row => row.code === code);
    if (index < 0 || list.rows[index].revision !== revision) {
      throw new RequestError(409, '这条需求已变化，请重新加载项目后再操作。');
    }
    if (action === 'remove') list.rows.splice(index, 1);
    else list.rows[index] = { code, ...cleanRequirement(fields), revision: randomUUID() };
  }
  return { requirements: projectRequirementRows(db, name) };
}

import { randomUUID } from 'node:crypto';
import { RequestError } from './store.mjs';

const stages = ['立项', 'EVT', 'DVT', 'PVT', 'MP'];
const emptyList = () => ({ next: 1, rows: [] });

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

function buildTemplate(source) {
  return Object.fromEntries(stages.map(stage => {
    const list = emptyList();
    for (const row of source[stage] ?? []) appendRequirement(stage, list, cleanRequirement(row));
    return [stage, list];
  }));
}

export function upgradeProjectRequirementTemplate(store) {
  const source = store.read().projectRequirementTemplate;
  if (!source || !stages.some(stage => Array.isArray(source[stage]))) return;
  store.update(db => { db.projectRequirementTemplate = buildTemplate(source); });
}

export function initializeProjectRequirements(db, name) {
  const lists = storedRequirements(db, name) ?? {};
  for (const stage of stages) {
    const defaults = db.projectRequirementTemplate?.[stage];
    if (!lists[stage]) {
      lists[stage] = defaults
        ? { next: defaults.next, rows: defaults.rows.map(row => ({ ...row, revision: randomUUID() })) }
        : emptyList();
    } else {
      // The initial seed can also populate projects that already have their own rows.
      for (const row of defaults?.rows ?? []) appendRequirement(stage, lists[stage], cleanRequirement(row));
    }
  }
  db.projectRequirements = { ...db.projectRequirements, [name]: lists };
  return lists;
}

export function seedProjectRequirements(store, seed) {
  if (store.read().projectRequirementTemplate) return;
  if (!seed || stages.slice(1).some(stage => !Array.isArray(seed[stage]) || !seed[stage].length)) {
    throw new Error('NPI 阶段种子数据应包含 EVT、DVT、PVT、MP 四组需求。');
  }
  const template = buildTemplate(seed);
  store.update(db => {
    db.projectRequirementTemplate = template;
    for (const name of db.demandOptions.proj) initializeProjectRequirements(db, name);
  });
}

function requirementRows(lists) {
  return Object.fromEntries(stages.map(stage => [stage, lists?.[stage]?.rows ?? []]));
}

export const projectRequirementRows = (db, name) => requirementRows(storedRequirements(db, name));
export const projectTemplateRows = db => requirementRows(db.projectRequirementTemplate);

function changeRequirement(lists, { stage, action, code, revision, ...fields }) {
  if (!stages.includes(stage) || !['add', 'update', 'remove'].includes(action)) {
    throw new RequestError(400, '项目阶段或需求操作无效。');
  }
  const list = lists[stage] ??= emptyList();
  if (action === 'add') {
    appendRequirement(stage, list, cleanRequirement(fields));
  } else {
    const index = list.rows.findIndex(row => row.code === code);
    if (index < 0 || list.rows[index].revision !== revision) {
      throw new RequestError(409, '这条需求已变化，请重新加载后再操作。');
    }
    if (action === 'remove') list.rows.splice(index, 1);
    else list.rows[index] = { code, ...cleanRequirement(fields), revision: randomUUID() };
  }
  return { requirements: requirementRows(lists) };
}

export function changeProjectRequirement(db, { name, ...input }) {
  if (!db.demandOptions.proj.includes(name)) throw new RequestError(404, '未找到此项目。');
  const stored = storedRequirements(db, name);
  const lists = stored ?? {};
  const result = changeRequirement(lists, input);
  if (!stored) db.projectRequirements = { ...db.projectRequirements, [name]: lists };
  return result;
}

export function changeProjectTemplateRequirement(db, input) {
  return changeRequirement(db.projectRequirementTemplate ??= {}, input);
}

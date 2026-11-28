import { randomUUID } from 'node:crypto';
import { RequestError } from './store.mjs';

const stages = ['立项', 'EVT', 'DVT', 'PVT', 'MP'];
const ckdStages = ['P1', 'P2', 'P3', 'P4', 'P5', 'P6', 'P7', 'P8'];
export const PROJECT_TYPES = ['标准项目', 'SKD', 'CKD'];
export const DEFAULT_PROJECT_TYPE = '标准项目';
const legacyInitiationCode = /^立项-/;
const emptyList = () => ({ next: 1, rows: [] });
export const projectTemplateStages = type => type === 'CKD' ? ckdStages : stages;
const emptyTemplate = type => Object.fromEntries(projectTemplateStages(type).map(stage => [stage, emptyList()]));

function normalizeProjectType(type) {
  return PROJECT_TYPES.includes(type) ? type : DEFAULT_PROJECT_TYPE;
}

function cleanRequirement(input, stage) {
  const { description, deliverable, planned_hours: hours } = input ?? {};
  if (typeof description !== 'string' || typeof deliverable !== 'string' ||
      description.length > 10000 || deliverable.length > 10000) {
    throw new RequestError(400, '需求说明和交付内容均须在 10000 字以内。');
  }
  if (!description.trim() && !deliverable.trim()) throw new RequestError(400, '请填写需求说明或交付内容。');
  if (hours !== null && (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0)) {
    throw new RequestError(400, '请输入有效的计划投入工时。');
  }
  const fields = { description: description.trim(), deliverable: deliverable.trim(), planned_hours: hours };
  if (ckdStages.includes(stage)) {
    const stepName = input.step_name ?? '';
    if (typeof stepName !== 'string' || stepName.length > 500) throw new RequestError(400, '步骤名须在 500 字以内。');
    fields.step_name = stepName.trim();
  }
  return fields;
}

function storedRequirements(db, name) {
  const projects = db.projectRequirements ?? {};
  return Object.hasOwn(projects, name) ? projects[name] : null;
}

function appendRequirement(stage, list, fields) {
  const prefix = stage === '立项' ? 'LX' : stage;
  const code = `${prefix}-${String(list.next++).padStart(3, '0')}`;
  list.rows.push({ code, ...fields, revision: randomUUID() });
}

function buildTemplate(source) {
  return Object.fromEntries(stages.map(stage => {
    const list = emptyList();
    for (const row of source[stage] ?? []) appendRequirement(stage, list, cleanRequirement(row));
    return [stage, list];
  }));
}

function initiationRows(db) {
  const templates = db.projectRequirementTemplates
    ? Object.values(db.projectRequirementTemplates)
    : [db.projectRequirementTemplate];
  return [...templates, ...Object.values(db.projectRequirements ?? {})]
    .flatMap(lists => lists?.立项?.rows ?? []);
}

export function ensureProjectRequirementTemplates(db) {
  const existing = db.projectRequirementTemplates;
  if (!existing || typeof existing !== 'object') {
    db.projectRequirementTemplates = {
      [DEFAULT_PROJECT_TYPE]: db.projectRequirementTemplate ?? emptyTemplate(),
      SKD: emptyTemplate(),
      CKD: emptyTemplate('CKD')
    };
  } else {
    for (const type of PROJECT_TYPES) {
      if (!existing[type]) existing[type] = type === DEFAULT_PROJECT_TYPE && db.projectRequirementTemplate
        ? db.projectRequirementTemplate
        : emptyTemplate(type);
    }
  }
  db.projectRequirementTemplate = db.projectRequirementTemplates[DEFAULT_PROJECT_TYPE];
  return db.projectRequirementTemplates;
}

export function upgradeProjectRequirements(store) {
  const current = store.read();
  const source = current.projectRequirementTemplate;
  const legacyTemplate = source && stages.some(stage => Array.isArray(source[stage]));
  const missingTemplates = !current.projectRequirementTemplates ||
    PROJECT_TYPES.some(type => !current.projectRequirementTemplates[type]);
  if (!legacyTemplate && !missingTemplates && !initiationRows(current).some(row => legacyInitiationCode.test(row.code))) return;
  store.update(db => {
    if (legacyTemplate) db.projectRequirementTemplate = buildTemplate(source);
    ensureProjectRequirementTemplates(db);
    for (const row of initiationRows(db)) {
      if (legacyInitiationCode.test(row.code)) row.code = row.code.replace(legacyInitiationCode, 'LX-');
    }
  });
}

export function initializeProjectRequirements(db, key, projectType = DEFAULT_PROJECT_TYPE) {
  const storeKey = String(key);
  const templates = ensureProjectRequirementTemplates(db);
  const template = templates[normalizeProjectType(projectType)];
  const lists = storedRequirements(db, storeKey) ?? {};
  for (const stage of projectTemplateStages(projectType)) {
    const defaults = template?.[stage];
    if (!lists[stage]) {
      lists[stage] = defaults
        ? { next: defaults.next, rows: defaults.rows.map(row => ({ ...row, revision: randomUUID() })) }
        : emptyList();
    } else {
      // The initial seed can also populate projects that already have their own rows.
      for (const row of defaults?.rows ?? []) appendRequirement(stage, lists[stage], cleanRequirement(row, stage));
    }
  }
  db.projectRequirements = { ...db.projectRequirements, [storeKey]: lists };
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
    ensureProjectRequirementTemplates(db);
    if (Array.isArray(db.projects)) {
      for (const project of db.projects) initializeProjectRequirements(db, project.id, project.project_type);
    } else {
      for (const name of db.demandOptions.proj) initializeProjectRequirements(db, name, DEFAULT_PROJECT_TYPE);
    }
  });
}

function requirementRows(lists, stageNames) {
  return Object.fromEntries(stageNames.map(stage => [stage, lists?.[stage]?.rows ?? []]));
}

export function projectRequirementStages(db, key) {
  const lists = storedRequirements(db, String(key));
  // Existing projects keep the workflow they were initialized with.
  return lists && ckdStages.some(stage => Object.hasOwn(lists, stage)) ? ckdStages : stages;
}

export const projectRequirementRows = (db, key) => requirementRows(storedRequirements(db, String(key)), projectRequirementStages(db, key));
export const projectTemplateRows = (db, projectType = DEFAULT_PROJECT_TYPE) => {
  const templates = db.projectRequirementTemplates;
  const source = templates ? templates[normalizeProjectType(projectType)] : (projectType === DEFAULT_PROJECT_TYPE ? db.projectRequirementTemplate : null);
  return requirementRows(source, projectTemplateStages(projectType));
};
export const allProjectTemplateRows = db => Object.fromEntries(
  PROJECT_TYPES.map(type => [type, projectTemplateRows(db, type)])
);

function changeRequirement(lists, stageNames, { stage, action, code, revision, ...fields }) {
  if (!stageNames.includes(stage) || !['add', 'update', 'remove'].includes(action)) {
    throw new RequestError(400, '项目阶段或需求操作无效。');
  }
  const list = lists[stage] ??= emptyList();
  if (action === 'add') {
    appendRequirement(stage, list, cleanRequirement(fields, stage));
  } else {
    const index = list.rows.findIndex(row => row.code === code);
    if (index < 0 || list.rows[index].revision !== revision) {
      throw new RequestError(409, '这条需求已变化，请重新加载后再操作。');
    }
    if (action === 'remove') list.rows.splice(index, 1);
    else list.rows[index] = {
      code,
      ...cleanRequirement(fields, stage),
      ...(list.rows[index].pushed ? { pushed: true } : {}),
      revision: randomUUID()
    };
  }
  return { requirements: requirementRows(lists, stageNames) };
}

export function changeProjectRequirement(db, { projectKey, name, ...input }) {
  const key = projectKey != null ? String(projectKey) : name;
  const stored = storedRequirements(db, key);
  const lists = stored ?? {};
  const result = changeRequirement(lists, projectRequirementStages(db, key), input);
  if (!stored) db.projectRequirements = { ...db.projectRequirements, [key]: lists };
  return result;
}

export function changeProjectTemplateRequirement(db, { project_type: projectType = DEFAULT_PROJECT_TYPE, ...input }) {
  if (!PROJECT_TYPES.includes(projectType)) throw new RequestError(400, '项目类型无效。');
  const templates = ensureProjectRequirementTemplates(db);
  const result = changeRequirement(templates[projectType], projectTemplateStages(projectType), input);
  return { ...result, project_type: projectType, templates: allProjectTemplateRows(db) };
}

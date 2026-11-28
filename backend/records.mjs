import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { attachmentKind, bindAttachments } from './attachments.mjs';
import { isAdmin, isDemandApprover, isPrimaryAdmin, now, optionalText } from './accounts.mjs';
import {
  allProjectTemplateRows, changeProjectRequirement, changeProjectTemplateRequirement, DEFAULT_PROJECT_TYPE,
  ensureProjectRequirementTemplates, initializeProjectRequirements, PROJECT_TYPES, projectRequirementRows,
  projectRequirementStages, projectTemplateStages
} from './project-requirements.mjs';
import { RequestError } from './store.mjs';
import { ACTIVE_TASK_STATUSES, formatPlanningTime, normalizeTaskPriority, plannedCompletion, TASK_PRIORITIES } from '../public/task-planning.mjs';

const fields = {
  profiles: { display_name: 100, emp_no: 100, role: 100, team: 100, status: 20, contact: 200, duty: 10000, remark: 10000 },
  tasks: {
    proj: 100, owner_name: 100, assignee_id: 0, status: 20, pri: 20, due: 10, start: 10, end: 10,
    device_type: 100,
    start_time: 10, end_time: 10, hours: 0, planned_hours: 0, result: 10000, desc: 10000
  },
  demands: { proj: 100, descr: 10000, proposer: 100, dispatcher_id: 0 }
};
const sequence = { profiles: 'profile', tasks: 'task', demands: 'demand' };
const statuses = ['待规划', ...ACTIVE_TASK_STATUSES, '已完成'];
const defaultPriority = '中';
const defaultProjectStage = '立项';
const demandCodePrefix = 'REQ';
const legacyDemandPrefix = /^FAE-/;
const catalogKinds = new Set(['proposer', 'device_type', 'project_stage', 'project_manager']);
const projectMetadataKeys = ['projectStages', 'projectRequirements', 'projectDescriptions', 'projectDeviceTypes', 'projectManagers', 'projectNpiManagers'];
const taskProgressFields = new Set(['status', 'result']);
const taskScheduleFields = ['due', 'start', 'end', 'start_time', 'end_time', 'planned_hours', 'started_at', 'planned_due_at', 'completed_at'];
const taskClassificationFields = ['pri', 'device_type'];
const retiredCollaboratorFields = ['collaborators', 'collaborator_ids', 'add_collaborator_ids', 'keep_as_collaborator'];
const recordCodeDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});
const taskCommentPageSize = 10;
const taskHistoryFieldLabels = {
  proj: '项目',
  device_type: '设备类型',
  pri: '优先级',
  status: '状态',
  desc: '任务描述'
};

function appendTaskHistory(db, user, taskId, summary) {
  if (!summary) return;
  db.taskHistory ??= {};
  const log = (db.taskHistory[taskId] ??= { nextId: 1, rows: [] });
  log.rows.push({
    id: log.nextId++,
    actor_name: displayName(db, user),
    summary,
    at: now()
  });
}

function taskFieldDiffs(before, after, keys = Object.keys(taskHistoryFieldLabels)) {
  const changes = [];
  for (const key of keys) {
    const prev = before[key] ?? null;
    const next = after[key] ?? null;
    if (prev === next) continue;
    const label = taskHistoryFieldLabels[key];
    if (key === 'desc') changes.push(`修改${label}`);
    else changes.push(`${label}：${prev || '空'} → ${next || '空'}`);
  }
  return changes;
}

function recordId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new RequestError(400, '记录编号无效。');
  return id;
}

const validId = value => Number.isSafeInteger(value) && value > 0;

function cleanFields(table, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RequestError(400, '没有可保存的内容。');
  if (table === 'tasks' && ['attachment_name', 'attachment_path'].some(key => Object.hasOwn(payload, key))) {
    throw new RequestError(400, '请刷新工作台后重新上传文件。');
  }
  const patch = {};
  for (const [key, maximum] of Object.entries(fields[table])) {
    if (!Object.hasOwn(payload, key)) continue;
    const value = payload[key];
    if (key === 'hours' || key === 'planned_hours') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new RequestError(400, key === 'hours' ? '投入工时须为非负数。' : '计划工时须为非负数。');
      }
      patch[key] = value;
    } else if (key === 'assignee_id' || key === 'dispatcher_id') {
      if (value !== null && !validId(value)) throw new RequestError(400, key === 'assignee_id' ? '负责人编号无效。' : '委托派发人编号无效。');
      patch[key] = value;
    } else if (key === 'pri') {
      const priority = normalizeTaskPriority(optionalText(value, maximum)) || defaultPriority;
      if (!TASK_PRIORITIES.includes(priority)) throw new RequestError(400, '任务优先级无效。');
      patch[key] = priority;
    } else {
      patch[key] = optionalText(value, maximum);
    }
  }
  return patch;
}

function displayName(db, user) {
  return db.profiles.find(row => row.owner_id === user.id)?.display_name || user.name;
}

function assignTask(db, task, input) {
  task.owner_name = input;
  task.assignee_id = null;
  if (!input) return;
  const account = db.users.find(user => user.account === input);
  const candidates = account ? [account] : db.users.filter(user => displayName(db, user) === input);
  if (candidates.length > 1) throw new RequestError(409, '有多位同名成员，请改填负责人的登录账号。');
  if (candidates.length === 1) {
    const [assignee] = candidates;
    task.assignee_id = assignee.id;
    task.owner_name = displayName(db, assignee);
  }
}

function taskOwnerName(db, task) {
  const assignee = db.users.find(user => user.id === task.assignee_id);
  return assignee ? displayName(db, assignee) : task.owner_name;
}

function assignCode(sequences, record, prefix, fallback) {
  const createdAt = Date.parse(record.created_at);
  const parts = recordCodeDate.formatToParts(Number.isFinite(createdAt) ? createdAt : fallback);
  const { year, month, day } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  const date = year + month + day;
  const next = (sequences[date] ?? 0) + 1;
  sequences[date] = next;
  record.code = `${prefix}-${date}${String(next).padStart(3, '0')}`;
}

function taskKind(payload) {
  if (payload.task_kind !== 'L' && payload.task_kind !== 'W' && payload.task_kind !== 'P') {
    throw new RequestError(400, '请选择有效的任务类型。');
  }
  return payload.task_kind;
}

export function backfillTaskCodes(db) {
  const fallback = Date.now();
  for (const task of db.tasks.filter(row => !row.code).sort((a, b) => a.id - b.id)) {
    const title = task.title?.trim();
    const desc = task.desc?.trim();
    const fromDemand = task.demand_id != null || Object.hasOwn(task, 'initial_receiver_id');
    if (title && !(fromDemand && /^FAE-\d{11,}$/.test(title))) {
      if (!desc) task.desc = title;
      else if (!desc.includes(title) && !(title.endsWith('…') && desc.startsWith(title.slice(0, -1)))) {
        task.desc = title + '\n' + task.desc;
      }
    }
    task.task_kind = 'W';
    assignCode(db.taskCodeSequences ??= {}, task, task.task_kind, fallback);
  }
}

function projectTupleKey(name, deviceType, projectType) {
  return JSON.stringify([name ?? '', deviceType ?? '', projectType || DEFAULT_PROJECT_TYPE]);
}

function syncDemandOptionProjects(db) {
  db.demandOptions.proj = [...new Set((db.projects ?? []).map(project => project.name))];
}

function projectStageOptions(db, project) {
  if (project) {
    const stages = projectRequirementStages(db, project.id);
    if (stages[0] === 'P1') return stages;
  }
  return [...new Set([defaultProjectStage, ...db.demandOptions.project_stage])];
}

function findProject(db, query) {
  const list = db.projects ?? [];
  if (typeof query === 'number') return list.find(project => project.id === query) ?? null;
  if (typeof query === 'string') {
    const byName = list.find(project => project.name === query);
    if (byName) return byName;
    if (/^\d+$/.test(query)) return list.find(project => project.id === Number(query)) ?? null;
    return null;
  }
  const { projectId, id, name } = query ?? {};
  const rawId = projectId ?? id;
  if (rawId != null && rawId !== '') {
    const num = Number(rawId);
    if (validId(num)) return list.find(project => project.id === num) ?? null;
  }
  if (typeof name === 'string' && name) {
    return list.find(project => project.name === name) ?? null;
  }
  return null;
}

function resolveProjectForRecord(db, projectId, projName) {
  const list = db.projects ?? [];
  if (validId(projectId)) return list.find(project => project.id === projectId) ?? null;
  if (typeof projName === 'string' && projName) {
    const matches = list.filter(project => project.name === projName);
    if (matches.length === 1) return matches[0];
  }
  return null;
}

function activePeople(db) {
  const users = new Map(db.users.map(user => [user.id, user]));
  return db.profiles
    .filter(profile => profile.status !== '已离职' && profile.display_name && users.has(profile.owner_id))
    .map(profile => {
      const user = users.get(profile.owner_id);
      return { id: user.id, name: profile.display_name, emp_no: profile.emp_no || user.account, is_admin: isAdmin(user) };
    });
}

function npiManagerNameById(db, id) {
  if (!validId(id)) return null;
  const user = db.users.find(account => account.id === id);
  if (user) return displayName(db, user);
  const profile = db.profiles.find(row => row.owner_id === id);
  return profile?.display_name || null;
}

function projectAttachments(db, project) {
  return db.attachments
    .filter(file => file.state === 'bound' && file.kind === 'project' &&
      (file.project_id === project.id || (file.project_id == null && file.project_name === project.name)))
    .map(({ id, kind, name: fileName, size, created_at }) => ({ id, kind, name: fileName, size, created_at: created_at ?? null }));
}

function projectSummary(db, project) {
  return {
    id: project.id,
    name: project.name,
    stage: project.stage || defaultProjectStage,
    description: project.description ?? null,
    device_type: project.device_type ?? null,
    project_type: project.project_type || DEFAULT_PROJECT_TYPE,
    project_manager: project.project_manager ?? null,
    npi_manager_id: validId(project.npi_manager_id) ? project.npi_manager_id : null,
    npi_manager: npiManagerNameById(db, project.npi_manager_id)
  };
}

function formatProjectRequirementDescription(row) {
  const lines = [];
  if (row.step_name) lines.push(`步骤名：${row.step_name}`);
  if (row.description) lines.push(`需求描述：${row.description}`);
  if (row.deliverable) lines.push(`交付内容：${row.deliverable}`);
  if (row.planned_hours != null) lines.push(`计划投入工时：${row.planned_hours} 小时`);
  return lines.join('\n') || null;
}

function projectDemandDate(timestamp) {
  const ms = Date.parse(timestamp);
  const parts = recordCodeDate.formatToParts(Number.isFinite(ms) ? ms : Date.now());
  const { year, month, day } = Object.fromEntries(parts.map(({ type, value }) => [type, value]));
  return year + month + day;
}

function projectDemandCode(project, reqCode, date) {
  const type = project.project_type || DEFAULT_PROJECT_TYPE;
  return type === DEFAULT_PROJECT_TYPE
    ? `${project.name}-${reqCode}-${date}`
    : `${project.name}-${type}-${reqCode}-${date}`;
}

function demandMatchesProject(demand, project) {
  if (demand.source_project_id != null) return demand.source_project_id === project.id;
  return demand.source_project === project.name;
}

function projectDemandAlreadyPushed(db, project, reqRow) {
  return Boolean(reqRow.pushed) || db.demands.some(demand =>
    demandMatchesProject(demand, project) && demand.source_requirement_code === reqRow.code
  );
}

function autoDispatchProjectDemand(db, project, demand, reqRow, adminUser, timestamp, recordTaskChange, deliveryFiles = [], uploader = null) {
  const npiId = validId(project.npi_manager_id) ? project.npi_manager_id : null;
  if (npiId == null) return null;
  const activeProfile = db.profiles.find(person => person.owner_id === npiId && person.status !== '已离职' && person.display_name);
  if (!activeProfile || !db.users.some(user => user.id === npiId)) return null;
  const dispatcher = adminUser ?? { id: npiId, name: '管理员' };
  const deviceType = project.device_type ?? null;
  const estimatedHours = typeof reqRow.planned_hours === 'number' && Number.isFinite(reqRow.planned_hours) && reqRow.planned_hours > 0
    ? Number(reqRow.planned_hours.toFixed(2)) : null;
  const due = estimatedHours != null ? plannedCompletion(timestamp, estimatedHours, defaultPriority) : null;
  const taskPatch = {
    assignee_id: npiId,
    proj: project.name,
    device_type: deviceType,
    pri: defaultPriority,
    desc: demand.descr,
    estimated_hours: estimatedHours,
    ...(due ? { status: '开发中', started_at: timestamp, planned_hours: estimatedHours, planned_due_at: due } : { status: '待规划' })
  };
  const taskRow = insertRecord(db, dispatcher, 'tasks', taskPatch, recordTaskChange, {
    demand_id: demand.id,
    project_id: project.id,
    project_type: project.project_type || DEFAULT_PROJECT_TYPE,
    dispatch_key: randomUUID(),
    task_kind: 'P',
    requirement_owner_id: demand.creator_id ?? demand.owner_id
  }).row;
  taskRow.initial_receiver_id = taskRow.assignee_id;
  taskRow.initial_receiver_name = taskRow.owner_name;
  let filePart = '';
  if (Array.isArray(deliveryFiles) && deliveryFiles.length) {
    const appBound = deliveryFiles.filter(file => {
      const stored = db.attachments.find(item => item.id === file?.id && item.kind === 'delivery' && item.state === 'bound' && item.project_application_id != null);
      return Boolean(stored);
    });
    if (appBound.length) {
      for (const file of appBound) {
        const stored = db.attachments.find(item => item.id === file.id);
        if (stored) {
          stored.task_id = taskRow.id;
          delete stored.project_application_id;
        }
      }
      filePart = `；上传交付文件：${appBound.map(file => file.name).join('、')}`;
    } else if (uploader) {
      bindAttachments(db, uploader, taskRow, 'delivery', deliveryFiles);
      filePart = `；上传交付文件：${deliveryFiles.map(file => file.name).join('、')}`;
    }
  }
  appendTaskHistory(db, dispatcher, taskRow.id, (due
    ? `从项目需求自动派发并开始规划（负责人：${taskRow.owner_name}，计划投入工时：${estimatedHours}h）`
    : `从项目需求自动派发任务（负责人：${taskRow.owner_name}）`) + filePart);
  notifyUsers(db, [npiId], {
    category: 'task_notice',
    event: 'assigned',
    title: `收到新的项目任务：${taskRow.code}`,
    body: `项目「${project.name}（${project.project_type || DEFAULT_PROJECT_TYPE}）」已自动派发任务「${taskRow.code}」给你${due ? `（已自动开始规划，计划工时 ${estimatedHours}h）` : ''}。`,
    actor_name: '管理员',
    target_type: 'task',
    target_id: taskRow.id
  });
  return taskRow;
}

function pushSingleProjectRequirement(db, project, reqRow, recordTaskChange, deliveryFiles = [], uploader = null) {
  if (projectDemandAlreadyPushed(db, project, reqRow)) return null;
  const adminUser = db.users.find(isPrimaryAdmin) ?? db.users.find(isAdmin);
  const adminId = adminUser?.id ?? null;
  const timestamp = now();
  const date = projectDemandDate(timestamp);
  const demand = {
    id: db.seq.demand++,
    owner_id: adminId,
    creator_id: adminId,
    owner_name: '管理员',
    proj: project.name,
    project_id: project.id,
    project_type: project.project_type || DEFAULT_PROJECT_TYPE,
    proposer: '项目',
    descr: formatProjectRequirementDescription(reqRow),
    code: projectDemandCode(project, reqRow.code, date),
    is_project_demand: true,
    source_project_id: project.id,
    source_project: project.name,
    source_requirement_code: reqRow.code,
    planned_hours: reqRow.planned_hours ?? null,
    created_at: timestamp,
    updated_at: timestamp
  };
  db.demands.unshift(demand);
  reqRow.pushed = true;
  const task = autoDispatchProjectDemand(db, project, demand, reqRow, adminUser, timestamp, recordTaskChange, deliveryFiles, uploader);
  return { demand, task };
}

function syncProjectStageDemands(db, project, stage, recordTaskChange, deliveryFilesByCode = {}, uploader = null) {
  const rows = db.projectRequirements?.[String(project.id)]?.[stage]?.rows ?? [];
  const created = [];
  for (const row of rows) {
    const files = Array.isArray(deliveryFilesByCode?.[row.code]) ? deliveryFilesByCode[row.code] : [];
    const entry = pushSingleProjectRequirement(db, project, row, recordTaskChange, files, uploader);
    if (entry) created.push(entry);
  }
  return created;
}

function enrichedProjectRequirements(db, project) {
  const grouped = projectRequirementRows(db, project.id);
  const demandsByCode = new Map();
  for (const demand of db.demands) {
    if (demandMatchesProject(demand, project) && demand.source_requirement_code && !demandsByCode.has(demand.source_requirement_code)) {
      demandsByCode.set(demand.source_requirement_code, demand);
    }
  }
  const tasksByDemandId = new Map();
  for (const task of db.tasks) {
    if (task.demand_id != null && !tasksByDemandId.has(task.demand_id)) {
      tasksByDemandId.set(task.demand_id, task);
    }
  }
  return Object.fromEntries(Object.entries(grouped).map(([stage, rows]) => [
    stage,
    rows.map(row => {
      const demand = demandsByCode.get(row.code);
      const task = demand ? tasksByDemandId.get(demand.id) : null;
      return {
        ...row,
        demand_id: demand?.id ?? null,
        demand_code: demand?.code ?? null,
        task_id: task?.id ?? null,
        task_code: task?.code ?? null,
        task_status: task?.status ?? null
      };
    })
  ]));
}

function projectCatalog(db) {
  const templates = allProjectTemplateRows(db);
  const initiationRequirementsByType = Object.fromEntries(PROJECT_TYPES.map(type => [
    type,
    templates[type][projectTemplateStages(type)[0]].map(({ code, description, deliverable, step_name }) => ({
      code, description, deliverable, step_name
    }))
  ]));
  return {
    projects: (db.projects ?? []).map(project => projectSummary(db, project)),
    stages: projectStageOptions(db),
    deviceTypes: db.demandOptions.device_type,
    projectTypes: PROJECT_TYPES,
    projectManagers: db.demandOptions.project_manager ?? [],
    people: activePeople(db),
    initiationRequirementsByType
  };
}

function taskHandledAt(user, task) {
  const transfer = task.transfer_history?.findLast(entry => entry.from_id === user.id || entry.to_id === user.id);
  if (transfer) return transfer.at;
  if (task.assignee_id === user.id || task.initial_receiver_id === user.id) return task.created_at ?? '';
  return null;
}

function publicTask(db, user, task, demand = db.demands.find(row => row.id === task.demand_id),
  files = db.attachments.filter(file => file.task_id === task.id && file.state === 'bound')) {
  const { title, dispatch_key, collaborators, transfer_history, revision, requirement_owner_id, category, deps, ...row } = task;
  if (Object.hasOwn(row, 'pri')) row.pri = normalizeTaskPriority(row.pri);
  if (demand) row.proj = demand.proj ?? null;
  if (dispatch_key || row.demand_id != null || Object.hasOwn(row, 'initial_receiver_id')) {
    row.dispatched_at = row.created_at ?? null;
    const dispatcherId = task.creator_id ?? task.owner_id;
    const dispatcher = db.users.find(account => account.id === dispatcherId);
    row.dispatched_by_name = dispatcher ? displayName(db, dispatcher)
      : db.profiles.find(profile => profile.owner_id === dispatcherId)?.display_name || null;
  }
  const handledAt = taskHandledAt(user, task);
  const resolvedProject = resolveProjectForRecord(db, row.project_id ?? demand?.project_id, row.proj);
  const hasPendingExtension = (db.taskExtensions ?? []).some(item => item.task_id === task.id && item.status === 'pending');
  return { ...row, owner_name: taskOwnerName(db, task), version: revision ?? 0,
    attachments: files.map(({ id, kind, name, size, created_at }) => ({ id, kind, name, size, created_at: created_at ?? null })),
    canAppendRequirement: canAppendAttachment(user, task, 'requirement'),
    canAppendDelivery: canAppendAttachment(user, task, 'delivery'),
    canDeleteDelivery: canDeleteDeliveryAttachment(user, task),
    canExtend: canExtendTask(db, user, task),
    hasPendingExtension,
    project_stage: resolvedProject ? (resolvedProject.stage || defaultProjectStage) : null,
    project_type: row.project_type ?? demand?.project_type ?? resolvedProject?.project_type ?? null,
    demand_code: demand?.code ?? null,
    handled_by_me: handledAt !== null, handled_at: handledAt || null };
}

function directoryProfile({ id, display_name, emp_no, team, role, status }) {
  return { id, display_name, emp_no, team, role, status };
}

function demandRequirementAttachments(db, demandId, linkedTasks) {
  const linkedIds = new Set(linkedTasks.map(task => task.id));
  return db.attachments.filter(file => file.state === 'bound' && file.kind === 'requirement' &&
    (file.demand_id === demandId || linkedIds.has(file.task_id)));
}

function demandApproverIds(db) {
  return db.users.filter(user => isDemandApprover(user, db)).map(user => user.id);
}

function demandApproverId(db, demand) {
  if (!demand) return null;
  if (validId(demand.approved_by_id)) return demand.approved_by_id;
  if (demandApprovalStatus(demand) === 'approved') {
    const creator = db.users.find(user => user.id === (demand.creator_id ?? demand.owner_id));
    if (creator && isDemandApprover(creator, db)) return creator.id;
  }
  return null;
}

function taskDemandApproverId(db, task) {
  if (task?.demand_id == null) return null;
  const demand = db.demands.find(row => row.id === task.demand_id);
  return demandApproverId(db, demand);
}

function notifyUsers(db, recipientIds, { category, event, title, body, actor_name = null, target_type = null, target_id = null }) {
  const uniqueIds = [...new Set(recipientIds.filter(validId))];
  if (!uniqueIds.length) return;
  db.messages ??= [];
  db.seq.message ??= 1;
  const timestamp = now();
  for (const recipientId of uniqueIds) {
    db.messages.unshift({
      id: db.seq.message++,
      recipient_id: recipientId,
      category,
      event,
      title,
      body,
      actor_name,
      target_type,
      target_id,
      read_at: null,
      created_at: timestamp
    });
  }
}

function canExtendTask(db, user, task) {
  if (!ACTIVE_TASK_STATUSES.includes(task.status) || !task.planned_due_at) return false;
  if (isDemandApprover(user, db)) return true;
  return (task.creator_id ?? task.owner_id) === user.id;
}

function publicTaskExtension(db, app) {
  const task = db.tasks.find(item => item.id === app.task_id);
  return {
    id: app.id,
    task_id: app.task_id,
    task_code: task?.code ?? app.task_code,
    proj: task?.proj ?? app.proj ?? null,
    owner_name: task ? (taskOwnerName(db, task) || null) : (app.owner_name ?? null),
    extend_hours: app.extend_hours,
    reason: app.reason ?? '',
    prev_planned_hours: app.prev_planned_hours ?? null,
    new_planned_hours: app.new_planned_hours ?? null,
    prev_planned_due_at: app.prev_planned_due_at ?? null,
    new_planned_due_at: app.new_planned_due_at ?? null,
    applicant_id: app.applicant_id ?? null,
    applicant_name: app.applicant_name ?? null,
    status: app.status || 'pending',
    reviewed_by_name: app.reviewed_by_name ?? null,
    reviewed_at: app.reviewed_at ?? null,
    reject_reason: app.reject_reason ?? null,
    created_at: app.created_at ?? null
  };
}

function publicProjectApplication(db, app) {
  return {
    id: app.id,
    name: app.name,
    device_type: app.device_type ?? null,
    project_type: app.project_type || DEFAULT_PROJECT_TYPE,
    project_manager: app.project_manager ?? null,
    npi_manager_id: validId(app.npi_manager_id) ? app.npi_manager_id : null,
    npi_manager: npiManagerNameById(db, app.npi_manager_id),
    initiation_files: app.initiation_files ?? {},
    initiation_requirements: app.initiation_requirements ?? [],
    applicant_id: app.applicant_id,
    applicant_name: app.applicant_name,
    status: app.status || 'pending',
    reviewed_by_name: app.reviewed_by_name ?? null,
    reviewed_at: app.reviewed_at ?? null,
    reject_reason: app.reject_reason ?? null,
    created_project_id: app.created_project_id ?? null,
    created_at: app.created_at ?? null
  };
}

function activeAdmins(db) {
  const profilesByOwner = new Map(db.profiles.map(profile => [profile.owner_id, profile]));
  return db.users
    .filter(user => {
      if (!isAdmin(user)) return false;
      const profile = profilesByOwner.get(user.id);
      return !profile || profile.status !== '已离职';
    })
    .map(user => {
      const profile = profilesByOwner.get(user.id);
      return {
        id: user.id,
        name: profile?.display_name || user.name,
        emp_no: profile?.emp_no || user.account,
        is_primary_admin: isPrimaryAdmin(user)
      };
    });
}

function demandApprovalStatus(row) {
  return row?.approval_status || 'approved';
}

function demandDispatcherId(row) {
  return row?.dispatcher_id ?? row?.creator_id ?? row?.owner_id ?? null;
}

function demandDispatcherName(db, row) {
  const id = demandDispatcherId(row);
  if (validId(id)) {
    const user = db.users.find(account => account.id === id);
    if (user) return displayName(db, user);
    const profile = db.profiles.find(item => item.owner_id === id);
    if (profile?.display_name) return profile.display_name;
  }
  return row?.dispatcher_name || row?.owner_name || null;
}

function canDispatchDemand(db, user, row) {
  if (!isAdmin(user) || demandApprovalStatus(row) !== 'approved') return false;
  if (isDemandApprover(user, db)) return true;
  return demandDispatcherId(row) === user.id;
}

function canManageDemandFiles(db, user, row) {
  if (!isAdmin(user)) return false;
  if (isDemandApprover(user, db)) return true;
  return demandDispatcherId(row) === user.id || (row.creator_id ?? row.owner_id) === user.id;
}

function canDeleteDemand(db, user, row) {
  if (!isAdmin(user)) return false;
  if (isDemandApprover(user, db)) return true;
  return demandApprovalStatus(row) === 'pending' && (row.creator_id ?? row.owner_id) === user.id;
}

function publicDemand(db, user, row, linkedTasks) {
  const assigned = db.profiles.find(profile => profile.owner_id === row.responsible_id);
  const files = demandRequirementAttachments(db, row.id, linkedTasks);
  const resolvedProject = resolveProjectForRecord(db, row.project_id ?? row.source_project_id, row.proj);
  const status = demandApprovalStatus(row);
  const dispatcherId = demandDispatcherId(row);
  return { ...row,
    approval_status: status,
    dispatcher_id: dispatcherId,
    dispatcher_name: demandDispatcherName(db, row),
    approved_by_name: row.approved_by_name ?? null,
    approved_at: row.approved_at ?? null,
    reject_reason: row.reject_reason ?? null,
    can_dispatch: canDispatchDemand(db, user, row),
    can_manage_files: canManageDemandFiles(db, user, row),
    can_delete: canDeleteDemand(db, user, row),
    project_stage: resolvedProject ? (resolvedProject.stage || defaultProjectStage) : null,
    project_type: row.project_type ?? resolvedProject?.project_type ?? null,
    responsible: assigned?.display_name || row.responsible || null,
    is_project_demand: Boolean(row.is_project_demand || row.proposer === '项目'),
    planned_hours: row.planned_hours ?? null,
    project_device_type: resolvedProject?.device_type ?? null,
    project_npi_manager_id: validId(resolvedProject?.npi_manager_id) ? resolvedProject.npi_manager_id : null,
    attachments: files.map(({ id, kind, name, size, created_at }) => ({ id, kind, name, size, created_at: created_at ?? null })),
    linked_tasks: linkedTasks.map(task => {
      const summary = { owner_name: taskOwnerName(db, task), initial_receiver_name: task.initial_receiver_name, status: task.status };
      return readableTask(db, user, task) ? { ...summary, id: task.id, code: task.code } : summary;
    }) };
}

function taskMember(db, id, label) {
  const profile = db.profiles.find(person => person.owner_id === id && person.status !== '已离职');
  if (!profile?.display_name || !db.users.some(user => user.id === id)) {
    throw new RequestError(409, label + '已不可选，请重新选择。');
  }
  return { id, name: profile.display_name };
}

function applyTaskAssignee(db, task, patch) {
  if (Object.hasOwn(patch, 'assignee_id') && patch.assignee_id !== task.assignee_id) {
    const owner = patch.assignee_id === null ? null : taskMember(db, patch.assignee_id, '负责人');
    task.assignee_id = owner?.id ?? null;
    task.owner_name = owner?.name ?? null;
  } else if (!Object.hasOwn(patch, 'assignee_id') && Object.hasOwn(patch, 'owner_name')) {
    // Older task clients may submit a name or login account when creating a task.
    assignTask(db, task, patch.owner_name);
    if (task.demand_id != null && task.assignee_id != null) taskMember(db, task.assignee_id, '负责人');
  }
  if (task.demand_id != null && !task.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');
  delete patch.owner_name;
  delete patch.assignee_id;
}

function checkTaskPeople(payload, creating) {
  if (retiredCollaboratorFields.some(field => Object.hasOwn(payload, field))) {
    throw new RequestError(400, '任务已停用合作者。');
  }
  if (!creating && ['assignee_id', 'owner_name'].some(field => Object.hasOwn(payload, field))) {
    throw new RequestError(400, '请通过转交负责人变更任务负责人。');
  }
}

function managesRecord(user, row) {
  return isAdmin(user) || (row.creator_id ?? row.owner_id) === user.id;
}

function visibleTask(user, task) {
  return managesRecord(user, task) || task.requirement_owner_id === user.id || taskHandledAt(user, task) !== null;
}

function isProjectTask(db, task) {
  if (!task) return false;
  if (task.task_kind === 'P') return true;
  if (task.demand_id == null) return false;
  const demand = db.demands.find(row => row.id === task.demand_id);
  return Boolean(demand && (demand.is_project_demand || demand.proposer === '项目'));
}

function readableTask(db, user, task) {
  return visibleTask(user, task) || isProjectTask(db, task);
}

function isProjectDemand(demand) {
  return Boolean(demand && (demand.is_project_demand || demand.proposer === '项目'));
}

function visibleDemandInList(user, linkedTasks) {
  if (isAdmin(user)) return true;
  return linkedTasks.some(task => task.assignee_id === user.id);
}

function readableDemand(user, demand, linkedTasks) {
  if (isAdmin(user)) return true;
  if (isProjectDemand(demand)) return true;
  return linkedTasks.some(task => task.assignee_id === user.id || taskHandledAt(user, task) !== null);
}

function canAppendAttachment(user, task, kind) {
  if (kind === 'requirement') {
    const fromDemand = task.demand_id != null || Object.hasOwn(task, 'initial_receiver_id');
    return fromDemand && (isAdmin(user) || task.requirement_owner_id === user.id);
  }
  return (task.status === '已完成' || ACTIVE_TASK_STATUSES.includes(task.status)) &&
    task.assignee_id === user.id;
}

function canDeleteDeliveryAttachment(user, task) {
  return ACTIVE_TASK_STATUSES.includes(task.status) && task.assignee_id === user.id;
}

function taskForComments(db, user, taskId) {
  const task = db.tasks.find(row => row.id === taskId);
  if (!task || !readableTask(db, user, task)) throw new RequestError(404, '未找到此任务。');
  return task;
}

function canCommentOnTask(db, user, task) {
  return task.status !== '已完成' && changeable(db, user, 'tasks', task, 'update', {});
}

function changeable(db, user, table, row, op, patch) {
  if (table === 'demands') {
    if (op === 'update') return false;
    if (op === 'delete') return canDeleteDemand(db, user, row);
    return isAdmin(user);
  }
  if (table === 'profiles') {
    if (row.owner_id === user.id) return op !== 'delete';
    return isAdmin(user) && !db.users.some(account => account.id === row.owner_id && isPrimaryAdmin(account));
  }
  if (table === 'tasks' && op === 'delete') {
    return isDemandApprover(user, db);
  }
  if (table === 'tasks' && op === 'update' && taskClassificationFields.some(field => Object.hasOwn(patch, field))) {
    const source = row.demand_id == null ? null : db.demands.find(demand => demand.id === row.demand_id);
    if (!managesRecord(user, source ?? row)) return false;
  }
  if (managesRecord(user, row)) return true;
  return table === 'tasks' && op === 'update' && row.assignee_id === user.id &&
    Object.keys(patch).every(field => taskProgressFields.has(field) || taskClassificationFields.includes(field));
}

function newTaskPatch(patch) {
  for (const field of [...taskScheduleFields, 'status', 'hours', 'result']) delete patch[field];
  return patch;
}

function checkTaskSchedule(payload) {
  if (taskScheduleFields.some(field => Object.hasOwn(payload, field))) {
    throw new RequestError(400, '任务时间和计划投入工时由任务流程记录。');
  }
}

function publicRecord(db, user, table, row) {
  if (table === 'tasks') return publicTask(db, user, row);
  if (table === 'demands') {
    return publicDemand(db, user, row, db.tasks.filter(task => task.demand_id === row.id));
  }
  return row;
}

function insertRecord(db, user, table, patch, recordTaskChange, extra = {}) {
  if (table === 'profiles' && db.profiles.some(row => row.owner_id === user.id)) {
    throw new RequestError(409, '你的个人档案已经存在。');
  }
  const row = { id: db.seq[sequence[table]]++, owner_id: user.id, owner_name: displayName(db, user), created_at: now(), ...extra };
  if (table !== 'profiles') row.creator_id = user.id;
  if (table === 'demands') assignCode(db.demandCodeSequences ??= {}, row, demandCodePrefix, Date.now());
  if (table === 'tasks') {
    Object.assign(row, { owner_name: null, assignee_id: null, status: statuses[0], pri: defaultPriority });
    assignCode(db.taskCodeSequences ??= {}, row, row.task_kind, Date.now());
  }
  const result = applyPatch(db, user, table, row, patch, recordTaskChange, true);
  db[table].unshift(row);
  return result;
}

export function insertHistoricalTask(db, admin, member, fields) {
  // Keep the full workbook log, including cells longer than the web form limit.
  const { desc, project_stage, ...attributes } = fields;
  const patch = { ...cleanFields('tasks', attributes), desc, project_stage: optionalText(project_stage) };
  const { row } = insertRecord(db, admin, 'tasks', patch, undefined, { task_kind: 'W' });
  // Match the existing account even when the member has since left the team.
  row.assignee_id = member.id;
  row.owner_name = member.name;
  delete row.pri;
  return row;
}

export function openRecords(store, { recordTaskChange, cleanupAttachments } = {}) {
  const planningKey = randomBytes(32);

  function planningTask(db, user, id) {
    const task = db.tasks.find(row => row.id === id);
    if (!task) throw new RequestError(404, '未找到此任务。');
    if (task.assignee_id !== user.id) throw new RequestError(403, '只有当前任务负责人可以开始规划。');
    if (task.status !== '待规划') throw new RequestError(409, '任务已不在待规划状态，请刷新后查看。');
    return task;
  }

  function planningSignature(user, task, minute) {
    return createHmac('sha256', planningKey).update(JSON.stringify([user.id, task, minute])).digest();
  }

  const needsDemandCode = demand => !demand.code || legacyDemandPrefix.test(demand.code);
  const needsReceiver = task => task.demand_id != null && !Object.hasOwn(task, 'initial_receiver_id');
  const needsRequirementOwner = task => task.demand_id != null && !Object.hasOwn(task, 'requirement_owner_id');
  const needsTestingRename = task => task.status === '测试中';
  const { demands, tasks } = store.read();
  if (demands.some(needsDemandCode) || tasks.some(task => needsReceiver(task) || needsRequirementOwner(task) || !task.code || needsTestingRename(task))) {
    store.update(db => {
      const fallback = Date.now();
      for (const demand of db.demands.filter(needsDemandCode).sort((a, b) => a.id - b.id)) {
        if (demand.code) demand.code = demand.code.replace(legacyDemandPrefix, demandCodePrefix + '-');
        else assignCode(db.demandCodeSequences ??= {}, demand, demandCodePrefix, fallback);
      }
      backfillTaskCodes(db);
      for (const task of db.tasks.filter(needsReceiver)) {
        task.initial_receiver_id = task.assignee_id ?? null;
        task.initial_receiver_name = taskOwnerName(db, task) ?? null;
      }
      const sources = new Map(db.demands.map(demand => [demand.id, demand]));
      for (const task of db.tasks.filter(needsRequirementOwner)) {
        const source = sources.get(task.demand_id);
        task.requirement_owner_id = source?.creator_id ?? source?.owner_id ?? null;
      }
      for (const task of db.tasks.filter(needsTestingRename)) {
        task.status = '测试验证';
      }
    });
  }
  if (!Array.isArray(store.read().projects)) {
    store.update(db => {
      db.seq.project ??= 1;
      const legacyStages = db.projectStages ?? {};
      const legacyDescriptions = db.projectDescriptions ?? {};
      const legacyDeviceTypes = db.projectDeviceTypes ?? {};
      const legacyManagers = db.projectManagers ?? {};
      const legacyNpi = db.projectNpiManagers ?? {};
      const legacyReqs = db.projectRequirements ?? {};
      const nextReqs = {};
      const idByName = new Map();
      db.projects = [];
      for (const projName of [...new Set(db.demandOptions.proj)]) {
        const id = db.seq.project++;
        idByName.set(projName, id);
        db.projects.push({
          id,
          name: projName,
          stage: (Object.hasOwn(legacyStages, projName) && legacyStages[projName]) || defaultProjectStage,
          description: Object.hasOwn(legacyDescriptions, projName) ? legacyDescriptions[projName] : null,
          device_type: Object.hasOwn(legacyDeviceTypes, projName) ? legacyDeviceTypes[projName] : null,
          project_type: DEFAULT_PROJECT_TYPE,
          project_manager: Object.hasOwn(legacyManagers, projName) ? legacyManagers[projName] : null,
          npi_manager_id: Object.hasOwn(legacyNpi, projName) && validId(legacyNpi[projName]) ? legacyNpi[projName] : null
        });
        if (Object.hasOwn(legacyReqs, projName)) nextReqs[String(id)] = legacyReqs[projName];
      }
      db.projectRequirements = nextReqs;
      for (const file of db.attachments) {
        if (file.kind === 'project' && file.project_id == null && idByName.has(file.project_name)) {
          file.project_id = idByName.get(file.project_name);
        }
      }
      const demandProjectMap = new Map();
      for (const demand of db.demands) {
        const matchedName = demand.source_project || demand.proj;
        if (matchedName && idByName.has(matchedName)) {
          const pid = idByName.get(matchedName);
          demand.project_id ??= pid;
          demand.project_type ??= DEFAULT_PROJECT_TYPE;
          if (demand.source_project === matchedName) demand.source_project_id ??= pid;
          demandProjectMap.set(demand.id, pid);
        }
      }
      for (const task of db.tasks) {
        const pid = (task.demand_id != null && demandProjectMap.get(task.demand_id)) ||
          (task.proj && idByName.get(task.proj)) || null;
        if (pid != null) {
          task.project_id ??= pid;
          task.project_type ??= DEFAULT_PROJECT_TYPE;
        }
      }
      ensureProjectRequirementTemplates(db);
      syncDemandOptionProjects(db);
    });
  }
  if (store.read().projectNpiSeeded !== true) {
    const snapshot = store.read();
    const hong = activePeople(snapshot).find(person => person.emp_no === '801946' || person.name === '洪俊峰');
    if (hong) {
      store.update(db => {
        for (const project of db.projects ?? []) {
          if (!validId(project.npi_manager_id)) project.npi_manager_id = hong.id;
        }
        db.projectNpiSeeded = true;
      });
    }
  }

  return {
    query(user, { table, op, eq, payload }) {
      if (!Object.hasOwn(fields, table) || !['select', 'insert', 'update', 'delete'].includes(op)) {
        throw new RequestError(400, '不支持的数据操作。');
      }
      if (op === 'select') {
        const db = store.read();
        if (table === 'profiles' && !isAdmin(user)) {
          return { data: db.profiles.map(row => row.owner_id === user.id ? row : directoryProfile(row)) };
        }
        if (table === 'tasks') {
          if (eq !== undefined) {
            const id = recordId(Array.isArray(eq) && eq[0] === 'id' ? eq[1] : null);
            const task = db.tasks.find(row => row.id === id);
            return { data: task && readableTask(db, user, task) ? [publicTask(db, user, task)] : [] };
          }
          const demands = new Map(db.demands.map(demand => [demand.id, demand]));
          const attachments = new Map();
          for (const file of db.attachments) {
            if (file.state !== 'bound') continue;
            if (!attachments.has(file.task_id)) attachments.set(file.task_id, []);
            attachments.get(file.task_id).push(file);
          }
          return {
            data: db.tasks.filter(task => visibleTask(user, task))
              .map(task => publicTask(db, user, task, demands.get(task.demand_id) ?? null, attachments.get(task.id) ?? []))
          };
        }
        if (table === 'demands') {
          if (eq !== undefined) {
            const id = recordId(Array.isArray(eq) && eq[0] === 'id' ? eq[1] : null);
            const demand = db.demands.find(row => row.id === id);
            if (!demand) return { data: [] };
            const linkedTasks = db.tasks.filter(task => task.demand_id === id);
            return { data: readableDemand(user, demand, linkedTasks) ? [publicDemand(db, user, demand, linkedTasks)] : [] };
          }
          const links = new Map();
          for (const task of db.tasks) {
            if (task.demand_id == null) continue;
            if (!links.has(task.demand_id)) links.set(task.demand_id, []);
            links.get(task.demand_id).push(task);
          }
          return {
            data: db.demands
              .filter(row => visibleDemandInList(user, links.get(row.id) || []))
              .map(row => publicDemand(db, user, row, links.get(row.id) || []))
          };
        }
        return { data: db[table] };
      }
      if (table === 'demands' && !isAdmin(user)) throw new RequestError(403, '仅管理员可以操作需求。');
      const id = op === 'insert' ? null : recordId(Array.isArray(eq) && eq[0] === 'id' ? eq[1] : null);
      const patch = op === 'delete' ? {} : cleanFields(table, payload);
      let extra;
      if (table === 'demands' && op !== 'delete') {
        if (op === 'update') throw new RequestError(403, '需求提交后项目、提出方和说明不可修改。');
        if (op === 'insert') {
          if (!patch.proj) throw new RequestError(400, '请填写项目。');
          if (!patch.proposer) throw new RequestError(400, '请选择需求提出方。');
          if (!patch.descr) throw new RequestError(400, '请填写需求说明。');
        }
      }
      if (table === 'tasks' && op !== 'delete') {
        checkTaskPeople(payload, op === 'insert');
        if (op === 'update') {
          checkTaskSchedule(payload);
          if (Object.hasOwn(patch, 'pri')) throw new RequestError(400, '任务派发后优先级不可修改。');
          if (Object.hasOwn(patch, 'hours')) throw new RequestError(400, '投入工时请在完成任务时填写。');
          if (Object.hasOwn(patch, 'result')) throw new RequestError(400, '完成结果请在完成任务时填写。');
        } else {
          extra = { task_kind: taskKind(payload) };
          if (!patch.desc) throw new RequestError(400, '请填写任务描述。');
          newTaskPatch(patch);
        }
      }
      const { row } = store.update(db => {
        const list = db[table];
        if (id !== null) {
          const index = list.findIndex(item => item.id === id);
          if (index === -1) throw new RequestError(404, '未找到此记录。');
          if (!changeable(db, user, table, list[index], op, patch)) {
            throw new RequestError(403, table === 'tasks' && op === 'delete'
              ? '仅超级管理员或指定审批人可以删除任务。'
              : '你没有权限修改或删除这条记录。');
          }
          if (table === 'tasks' && list[index].status === '已完成') {
            if (op === 'update') throw new RequestError(409, '任务已完成，无法修改。');
            if (!isDemandApprover(user, db)) throw new RequestError(403, '仅超级管理员或指定审批人可以删除任务。');
          }
          if (op === 'delete') {
            if (table === 'demands') {
              if (db.tasks.some(task => task.demand_id === id)) {
                throw new RequestError(409, '该需求已关联任务，无法删除。');
              }
              for (const file of db.attachments) {
                if (file.demand_id === id && file.task_id == null) file.state = 'deleting';
              }
            }
            const [row] = list.splice(index, 1);
            if (table === 'tasks') {
              delete db.taskComments?.[row.id];
              delete db.taskHistory?.[row.id];
              for (const file of db.attachments) if (file.task_id === row.id) file.state = 'deleting';
              if (row.status !== '已完成' && validId(row.assignee_id) && row.assignee_id !== user.id) {
                const actorName = displayName(db, user);
                notifyUsers(db, [row.assignee_id], {
                  category: 'task_notice',
                  event: 'deleted',
                  title: `任务已删除：${row.code}`,
                  body: `${actorName} 已删除分配给你的任务「${row.code}」${row.proj ? `（${row.proj}）` : ''}。`,
                  actor_name: actorName,
                  target_type: null,
                  target_id: null
                });
              }
            }
            return { row };
          }
          let taskBefore = null;
          if (table === 'tasks') {
            const current = list[index].status;
            if (Object.hasOwn(patch, 'status') && patch.status !== current) {
              if (list[index].assignee_id !== user.id) {
                throw new RequestError(403, '只有当前任务负责人可以切换任务状态。');
              }
              if (!(ACTIVE_TASK_STATUSES.includes(current) && ACTIVE_TASK_STATUSES.includes(patch.status))) {
                throw new RequestError(409, '任务状态只能在开发中和测试验证中切换。开始任务请使用开始规划。');
              }
            }
            const t = list[index];
            taskBefore = { proj: t.proj, device_type: t.device_type, pri: normalizeTaskPriority(t.pri), status: t.status, desc: t.desc };
          }
          const updated = applyPatch(db, user, table, list[index], patch, recordTaskChange);
          if (taskBefore) {
            const diffs = taskFieldDiffs(taskBefore, { ...updated.row, pri: normalizeTaskPriority(updated.row.pri) });
            if (diffs.length) appendTaskHistory(db, user, updated.row.id, diffs.join('；'));
          }
          return updated;
        }
        if (table === 'demands' && op === 'insert') {
          if (patch.proposer && !db.demandOptions.proposer.includes(patch.proposer)) {
            db.demandOptions.proposer.push(patch.proposer);
          }
          const isApprover = isDemandApprover(user, db);
          let dispatcherId = user.id;
          if (isApprover && patch.dispatcher_id != null) {
            const candidate = activeAdmins(db).find(adminUser => adminUser.id === patch.dispatcher_id);
            if (!candidate) throw new RequestError(409, '所选委托派发人不是有效管理员，请重新选择。');
            dispatcherId = candidate.id;
          }
          delete patch.dispatcher_id;
          extra = {
            ...extra,
            approval_status: isApprover ? 'approved' : 'pending',
            dispatcher_id: dispatcherId
          };
        }
        const inserted = insertRecord(db, user, table, patch, recordTaskChange, extra);
        if (table === 'demands' && op === 'insert' && inserted.row.approval_status === 'pending') {
          const applicantName = displayName(db, user);
          notifyUsers(db, demandApproverIds(db), {
            category: 'demand_approval',
            event: 'submitted',
            title: `新的需求审批申请：${inserted.row.code}`,
            body: `${applicantName} 提交了「${inserted.row.proj}」的需求申请（提出方：${inserted.row.proposer}），请前往审批中心处理。`,
            actor_name: applicantName,
            target_type: 'demand',
            target_id: inserted.row.id
          });
        } else if (table === 'demands' && op === 'insert' && inserted.row.approval_status === 'approved' &&
            validId(inserted.row.dispatcher_id) && inserted.row.dispatcher_id !== user.id) {
          const creatorName = displayName(db, user);
          notifyUsers(db, [inserted.row.dispatcher_id], {
            category: 'demand_approval',
            event: 'delegated',
            title: `收到委托待派发需求：${inserted.row.code}`,
            body: `${creatorName} 创建了「${inserted.row.proj}」的需求「${inserted.row.code}」并委托你进行派发。`,
            actor_name: creatorName,
            target_type: 'demand',
            target_id: inserted.row.id
          });
        }
        if (table === 'tasks') {
          appendTaskHistory(db, user, inserted.row.id,
            inserted.row.owner_name ? `创建任务（负责人：${inserted.row.owner_name}）` : '创建任务');
        }
        return inserted;
      });
      if ((table === 'tasks' || table === 'demands') && op === 'delete') void cleanupAttachments?.();
      return { data: [publicRecord(store.read(), user, table, row)] };
    },

    listTaskComments(user, { taskId, before }) {
      const db = store.read();
      const task = taskForComments(db, user, recordId(taskId));
      const cursor = before == null ? null : recordId(before);
      const rows = db.taskComments?.[task.id]?.rows ?? [];
      const end = cursor === null ? rows.length : rows.findLastIndex(row => row.id < cursor) + 1;
      const recent = rows.slice(Math.max(0, end - taskCommentPageSize), end).reverse();
      const canComment = canCommentOnTask(db, user, task);
      return {
        comments: recent.map(({ author_id, ...row }) => ({
          ...row,
          canEdit: canComment && author_id === user.id,
          canDelete: canComment && (author_id === user.id || isAdmin(user))
        })),
        before: end > taskCommentPageSize ? recent.at(-1).id : null,
        canComment
      };
    },

    changeTaskComment(user, { taskId, action, commentId, expectedVersion, body }) {
      const id = recordId(taskId);
      if (!['create', 'update', 'delete'].includes(action)) throw new RequestError(400, '评论操作无效。');
      const message = action === 'delete' ? null : optionalText(body, 2000);
      if (action !== 'delete' && !message) throw new RequestError(400, '请填写评论。');
      return store.update(db => {
        const task = taskForComments(db, user, id);
        if (!canCommentOnTask(db, user, task)) throw new RequestError(403, '你目前没有权限修改此任务的评论。');
        if (action === 'create') {
          db.taskComments ??= {};
          const thread = (db.taskComments[id] ??= { nextId: 1, rows: [] });
          thread.rows.push({ id: thread.nextId++, author_id: user.id, author_name: displayName(db, user),
            body: message, created_at: now(), edited_at: null, version: 0 });
          return {};
        }
        const rows = db.taskComments?.[id]?.rows ?? [];
        const comment = recordId(commentId);
        const index = rows.findIndex(row => row.id === comment);
        if (index === -1) throw new RequestError(404, '找不到这条评论。');
        const row = rows[index];
        if (row.author_id !== user.id && (action !== 'delete' || !isAdmin(user))) {
          throw new RequestError(403, '你没有权限操作这条评论。');
        }
        if (row.version !== expectedVersion) throw new RequestError(409, '评论已变化，请刷新后重试。');
        if (action === 'delete') rows.splice(index, 1);
        else if (row.body !== message) Object.assign(row, { body: message, edited_at: now(), version: row.version + 1 });
        return {};
      });
    },

    previewTaskPlan(user, { taskId }) {
      const db = store.read();
      const task = planningTask(db, user, recordId(taskId));
      const minute = Math.floor(Date.now() / 60_000);
      const startToken = `${minute}.${planningSignature(user, task, minute).toString('hex')}`;
      return { startToken, startedAt: new Date(minute * 60_000).toISOString(), task: publicTask(db, user, task) };
    },

    startTask(user, { taskId, startToken, plannedHours, changes = {} }) {
      const id = recordId(taskId);
      const token = typeof startToken === 'string' && /^(\d{1,10})\.([a-f0-9]{64})$/.exec(startToken);
      if (!token) throw new RequestError(400, '规划凭证无效，请重新打开开始规划。');
      const [, minuteText, signature] = token;
      const minute = Number(minuteText);
      const patch = cleanFields('tasks', changes);
      checkTaskSchedule(changes);
      checkTaskPeople(changes, false);
      if (Object.hasOwn(patch, 'pri')) throw new RequestError(400, '开始规划时优先级为只读。');
      if (['status', 'hours', 'result'].some(field => Object.hasOwn(patch, field))) {
        throw new RequestError(400, '开始任务时只填写计划投入工时。');
      }
      const { row } = store.update(db => {
        const task = planningTask(db, user, id);
        if (!timingSafeEqual(planningSignature(user, task, minute), Buffer.from(signature, 'hex'))) {
          throw new RequestError(409, '规划凭证已失效，请刷新并重新打开开始规划。');
        }
        if (!changeable(db, user, 'tasks', task, 'update', patch)) throw new RequestError(403, '你没有权限修改这些任务信息。');
        const startedAt = new Date(minute * 60_000).toISOString();
        const priority = normalizeTaskPriority(task.pri);
        const due = plannedCompletion(startedAt, plannedHours, TASK_PRIORITIES.includes(priority) ? priority : defaultPriority);
        if (!due) throw new RequestError(400, '请填写有效的计划投入工时，至少为 1 分钟。');
        const before = { proj: task.proj, device_type: task.device_type, desc: task.desc };
        Object.assign(patch, { status: '开发中', started_at: startedAt, planned_hours: plannedHours, planned_due_at: due });
        const result = applyPatch(db, user, 'tasks', task, patch, recordTaskChange);
        const diffs = taskFieldDiffs(before, result.row, ['proj', 'device_type', 'desc']);
        appendTaskHistory(db, user, result.row.id,
          [`开始规划（状态：待规划 → 开发中，计划投入工时：${plannedHours}h）`, ...diffs].join('；'));
        const dispatcherId = result.row.creator_id ?? result.row.owner_id;
        if (validId(dispatcherId) && dispatcherId !== user.id) {
          const actorName = displayName(db, user);
          notifyUsers(db, [dispatcherId], {
            category: 'task_notice',
            event: 'planned',
            title: `任务已开始规划：${result.row.code}`,
            body: `${actorName} 已开始规划任务「${result.row.code}」${result.row.proj ? `（${result.row.proj}）` : ''}，计划投入 ${plannedHours}h，计划完成时间 ${formatPlanningTime(due)}。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: result.row.id
          });
        }
        return result;
      });
      return { task: publicTask(store.read(), user, row) };
    },

    completeTask(user, { taskId, expectedVersion, hours, changes, files }) {
      const id = recordId(taskId);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new RequestError(400, '请刷新任务后重试。');
      }
      if (typeof hours !== 'number' || !Number.isFinite(hours) || hours < 0) {
        throw new RequestError(400, '请填写有效的投入工时，可填 0。');
      }
      const patch = cleanFields('tasks', changes);
      checkTaskSchedule(changes);
      checkTaskPeople(changes, false);
      if (!patch.result) throw new RequestError(400, '请填写完成结果。');
      if (Object.hasOwn(patch, 'pri')) throw new RequestError(400, '任务派发后优先级不可修改。');
      if (Object.hasOwn(patch, 'status') || Object.hasOwn(patch, 'hours')) {
        throw new RequestError(400, '任务状态和投入工时由完成操作记录。');
      }

      const { row } = store.update(db => {
        const task = db.tasks.find(item => item.id === id);
        if (!task || !visibleTask(user, task)) throw new RequestError(404, '未找到此任务。');
        if (task.assignee_id !== user.id) {
          throw new RequestError(403, '只有当前任务负责人可以完成任务。');
        }
        if (!changeable(db, user, 'tasks', task, 'update', patch)) {
          throw new RequestError(403, '你没有权限完成此任务或修改这些任务信息。');
        }
        if (!ACTIVE_TASK_STATUSES.includes(task.status)) {
          throw new RequestError(409, '只有开发中或测试验证的任务可以完成，请刷新后查看。');
        }
        if ((task.revision ?? 0) !== expectedVersion) throw new RequestError(409, '任务已变化，请重新打开更新任务后重试。');
        const prevStatus = task.status;
        const before = { proj: task.proj, device_type: task.device_type, pri: normalizeTaskPriority(task.pri), desc: task.desc };
        bindAttachments(db, user, task, 'delivery', files);
        Object.assign(patch, { status: '已完成', hours, completed_at: now() });
        const result = applyPatch(db, user, 'tasks', task, patch, recordTaskChange);
        const diffs = taskFieldDiffs(before, { ...result.row, pri: normalizeTaskPriority(result.row.pri) }, ['proj', 'device_type', 'pri', 'desc']);
        const filePart = files?.length ? [`上传交付文件：${files.map(file => file.name).join('、')}`] : [];
        appendTaskHistory(db, user, result.row.id,
          [`完成任务（状态：${prevStatus} → 已完成，投入工时：${hours}h）`, ...diffs, ...filePart].join('；'));
        const dispatcherId = result.row.creator_id ?? result.row.owner_id;
        const approverId = taskDemandApproverId(db, result.row);
        const recipients = [...new Set([dispatcherId, approverId].filter(uid => validId(uid) && uid !== user.id))];
        if (recipients.length) {
          const actorName = displayName(db, user);
          notifyUsers(db, recipients, {
            category: 'task_notice',
            event: 'completed',
            title: `任务已完成：${result.row.code}`,
            body: `${actorName} 已完成任务「${result.row.code}」${result.row.proj ? `（${result.row.proj}）` : ''}，投入工时 ${hours}h，请及时查看验收。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: result.row.id
          });
        }
        return result;
      });
      return { task: publicTask(store.read(), user, row) };
    },

    dispatchDemand(user, { demandId, dispatchKey, task, files, estimatedHours }) {
      const id = recordId(demandId);
      if (typeof dispatchKey !== 'string' || !/^[a-f0-9-]{36}$/.test(dispatchKey)) throw new RequestError(400, '派发编号无效。');
      const patch = newTaskPatch(cleanFields('tasks', task));
      checkTaskPeople(task, true);
      if (!patch.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');
      if (!optionalText(task.pri, fields.tasks.pri)) throw new RequestError(400, '请选择优先级。');
      if (!patch.device_type) throw new RequestError(400, '请填写设备类型。');
      const kind = taskKind(task);
      if (estimatedHours != null && (!Number.isFinite(estimatedHours) || estimatedHours !== Number(estimatedHours.toFixed(2)) ||
          !plannedCompletion(now(), estimatedHours, patch.pri))) {
        throw new RequestError(400, '请填写有效的预计工时，最小 0.01 小时，最多两位小数。');
      }

      const { created, demand } = store.update(db => {
        const source = db.demands.find(row => row.id === id);
        if (!source) throw new RequestError(404, '未找到此需求。');
        if (demandApprovalStatus(source) !== 'approved') throw new RequestError(409, '该需求尚未审批通过，暂不能派发。');
        if (!canDispatchDemand(db, user, source)) throw new RequestError(403, '只有委托派发人或审批管理员可以派发此需求。');
        const existing = db.tasks.find(row => row.demand_id === id);
        if (existing) {
          if (existing.creator_id === user.id && existing.dispatch_key === dispatchKey) return { created: existing, demand: source };
          throw new RequestError(409, '这条需求已经派发。');
        }
        const details = { desc: source.descr ?? null, ...patch, proj: source.proj ?? null, estimated_hours: estimatedHours ?? null };
        const row = insertRecord(db, user, 'tasks', details, recordTaskChange, {
          demand_id: id,
          project_id: source.project_id ?? source.source_project_id ?? null,
          project_type: source.project_type ?? null,
          dispatch_key: dispatchKey, task_kind: kind,
          requirement_owner_id: source.creator_id ?? source.owner_id
        }).row;
        bindAttachments(db, user, row, 'requirement', files, { extra: { demand_id: id } });
        for (const file of db.attachments) {
          if (file.demand_id === id && file.kind === 'requirement' && file.state === 'bound' && file.task_id == null) {
            file.task_id = row.id;
          }
        }
        row.initial_receiver_id = row.assignee_id;
        row.initial_receiver_name = row.owner_name;
        const filePart = files?.length ? `；上传需求文件：${files.map(file => file.name).join('、')}` : '';
        appendTaskHistory(db, user, row.id, `从需求派发任务（负责人：${row.owner_name || '未分配'}${filePart}）`);
        if (validId(row.assignee_id) && row.assignee_id !== user.id) {
          const actorName = displayName(db, user);
          notifyUsers(db, [row.assignee_id], {
            category: 'task_notice',
            event: 'assigned',
            title: `收到新任务：${row.code}`,
            body: `${actorName} 将需求「${source.code}」${source.proj ? `（${source.proj}）` : ''}派发给你，任务编号：${row.code}。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: row.id
          });
        }
        const approverId = demandApproverId(db, source);
        if (validId(approverId) && approverId !== user.id && approverId !== row.assignee_id) {
          const actorName = displayName(db, user);
          notifyUsers(db, [approverId], {
            category: 'task_notice',
            event: 'dispatched',
            title: `委托需求已派发：${row.code}`,
            body: `${actorName} 已将需求「${source.code}」${source.proj ? `（${source.proj}）` : ''}派发给 ${row.owner_name || '未分配'}，任务编号：${row.code}。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: row.id
          });
        }
        return { created: row, demand: source };
      });
      const db = store.read();
      return { task: publicTask(db, user, created, demand), demand: publicRecord(db, user, 'demands', demand) };
    },

    transferTask(user, { taskId, assignee_id: assigneeId, expectedVersion }) {
      if (!isAdmin(user)) throw new RequestError(403, '只有管理员可以转交任务。');
      const id = recordId(taskId);
      if (!validId(assigneeId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new RequestError(400, '请选择接手人并刷新任务后重试。');
      }
      const { row } = store.update(db => {
        const task = db.tasks.find(item => item.id === id);
        if (!task || !visibleTask(user, task)) throw new RequestError(404, '未找到此任务。');
        if ((task.revision ?? 0) !== expectedVersion) throw new RequestError(409, '任务已变化，请刷新后重新转交。');
        if (task.status === '已完成') throw new RequestError(409, '已完成的任务不能转交。');
        if (task.assignee_id === assigneeId) throw new RequestError(400, '请选择其他成员接手任务。');
        const prevAssigneeId = task.assignee_id ?? null;
        const prevOwner = taskOwnerName(db, task) || '未分配';
        task.transfer_history ??= [];
        task.transfer_history.push({ from_id: prevAssigneeId, to_id: assigneeId, at: now() });
        const result = applyPatch(db, user, 'tasks', task, { assignee_id: assigneeId }, recordTaskChange);
        const nextOwner = taskOwnerName(db, result.row) || '未分配';
        appendTaskHistory(db, user, result.row.id, `转交负责人：${prevOwner} → ${nextOwner}`);
        const actorName = displayName(db, user);
        if (validId(assigneeId) && assigneeId !== user.id) {
          notifyUsers(db, [assigneeId], {
            category: 'task_notice',
            event: 'transferred_in',
            title: `收到转交任务：${result.row.code}`,
            body: `${actorName} 将任务「${result.row.code}」${result.row.proj ? `（${result.row.proj}）` : ''}从 ${prevOwner} 转交给你负责。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: result.row.id
          });
        }
        if (validId(prevAssigneeId) && prevAssigneeId !== user.id && prevAssigneeId !== assigneeId) {
          notifyUsers(db, [prevAssigneeId], {
            category: 'task_notice',
            event: 'transferred_out',
            title: `任务已转出：${result.row.code}`,
            body: `${actorName} 已将任务「${result.row.code}」${result.row.proj ? `（${result.row.proj}）` : ''}转交给 ${nextOwner} 负责。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: result.row.id
          });
        }
        const approverId = taskDemandApproverId(db, result.row);
        if (validId(approverId) && approverId !== user.id && approverId !== assigneeId && approverId !== prevAssigneeId) {
          notifyUsers(db, [approverId], {
            category: 'task_notice',
            event: 'transferred_notice',
            title: `任务已转交：${result.row.code}`,
            body: `${actorName} 将任务「${result.row.code}」${result.row.proj ? `（${result.row.proj}）` : ''}负责人由 ${prevOwner} 转交给 ${nextOwner}。`,
            actor_name: actorName,
            target_type: 'task',
            target_id: result.row.id
          });
        }
        return result;
      });
      return { task: publicTask(store.read(), user, row) };
    },

    demandChoices() {
      const db = store.read();
      return { options: db.demandOptions, people: activePeople(db), admins: activeAdmins(db) };
    },

    reviewDemand(user, { demandId, decision, reason }) {
      const id = recordId(demandId);
      if (!['approve', 'reject'].includes(decision)) throw new RequestError(400, '审批操作无效。');
      const rejectReason = decision === 'reject' ? optionalText(reason, 500) : null;
      const row = store.update(db => {
        if (!isDemandApprover(user, db)) throw new RequestError(403, '仅超级管理员或指定审批人可以审批需求。');
        const demand = db.demands.find(item => item.id === id);
        if (!demand) throw new RequestError(404, '未找到此需求。');
        if (demandApprovalStatus(demand) !== 'pending') throw new RequestError(409, '该需求已审批，无需重复操作。');
        const timestamp = now();
        demand.approval_status = decision === 'approve' ? 'approved' : 'rejected';
        demand.approved_by_id = user.id;
        demand.approved_by_name = displayName(db, user);
        demand.approved_at = timestamp;
        demand.reject_reason = rejectReason;
        demand.updated_at = timestamp;
        const recipientId = demand.creator_id ?? demand.owner_id;
        if (validId(recipientId)) {
          notifyUsers(db, [recipientId], {
            category: 'demand_approval',
            event: decision === 'approve' ? 'approved' : 'rejected',
            title: decision === 'approve' ? `需求申请已通过：${demand.code}` : `需求申请已驳回：${demand.code}`,
            body: decision === 'approve'
              ? `${demand.approved_by_name} 已审批通过你提交的需求「${demand.code}」（${demand.proj}），现在可以进行派发。`
              : `${demand.approved_by_name} 驳回了你提交的需求「${demand.code}」（${demand.proj}）${rejectReason ? `，驳回原因：${rejectReason}` : ''}。`,
            actor_name: demand.approved_by_name,
            target_type: 'demand',
            target_id: demand.id
          });
        }
        return demand;
      });
      return { demand: publicRecord(store.read(), user, 'demands', row) };
    },

    projectCatalog: () => projectCatalog(store.read()),

    projectDetail(query) {
      const db = store.read();
      const project = findProject(db, query);
      if (!project) throw new RequestError(404, '未找到此项目。');
      return {
        project: projectSummary(db, project),
        stages: projectStageOptions(db, project),
        deviceTypes: db.demandOptions.device_type,
        projectTypes: PROJECT_TYPES,
        projectManagers: db.demandOptions.project_manager ?? [],
        people: activePeople(db),
        attachments: projectAttachments(db, project),
        requirements: enrichedProjectRequirements(db, project)
      };
    },

    changeProjectRequirement: input => store.update(db => {
      const project = findProject(db, input);
      if (!project) throw new RequestError(404, '未找到此项目。');
      changeProjectRequirement(db, { ...input, projectKey: project.id });
      return { requirements: enrichedProjectRequirements(db, project) };
    }),

    pushProjectRequirement(user, { projectId, id, name, stage, code }) {
      if (typeof stage !== 'string' || !stage || typeof code !== 'string' || !code) {
        throw new RequestError(400, '推送参数无效。');
      }
      const current = store.read();
      const currentProject = findProject(current, { projectId, id, name });
      if (!currentProject) throw new RequestError(404, '未找到此项目。');
      const existingRow = current.projectRequirements?.[String(currentProject.id)]?.[stage]?.rows?.find(item => item.code === code);
      if (!existingRow) throw new RequestError(404, '未找到这条阶段需求，请刷新后重试。');
      if (projectDemandAlreadyPushed(current, currentProject, existingRow)) {
        return { alreadyPushed: true, requirements: enrichedProjectRequirements(current, currentProject) };
      }
      const result = store.update(db => {
        const project = findProject(db, { projectId: currentProject.id });
        if (!project) throw new RequestError(404, '未找到此项目。');
        const row = db.projectRequirements?.[String(project.id)]?.[stage]?.rows?.find(item => item.code === code);
        if (!row) throw new RequestError(404, '未找到这条阶段需求，请刷新后重试。');
        if (projectDemandAlreadyPushed(db, project, row)) {
          return { alreadyPushed: true, demand: null, task: null, requirements: enrichedProjectRequirements(db, project) };
        }
        const entry = pushSingleProjectRequirement(db, project, row, recordTaskChange);
        return { alreadyPushed: false, demand: entry?.demand ?? null, task: entry?.task ?? null, requirements: enrichedProjectRequirements(db, project) };
      });
      const db = store.read();
      return {
        alreadyPushed: result.alreadyPushed,
        demand: result.demand ? publicRecord(db, user, 'demands', result.demand) : null,
        task: result.task ? publicTask(db, user, result.task, result.demand) : null,
        requirements: result.requirements
      };
    },

    pushProjectStageRequirements(user, { projectId, id, name, stage }) {
      if (typeof stage !== 'string' || !stage) {
        throw new RequestError(400, '推送参数无效。');
      }
      const result = store.update(db => {
        const project = findProject(db, { projectId, id, name });
        if (!project) throw new RequestError(404, '未找到此项目。');
        const created = syncProjectStageDemands(db, project, stage, recordTaskChange);
        return { created, requirements: enrichedProjectRequirements(db, project) };
      });
      const db = store.read();
      return {
        pushedCount: result.created.length,
        demands: result.created.map(({ demand }) => publicRecord(db, user, 'demands', demand)),
        tasks: result.created.filter(({ task }) => task).map(({ demand, task }) => publicTask(db, user, task, demand)),
        requirements: result.requirements
      };
    },

    projectRequirementTemplate: () => ({
      templates: allProjectTemplateRows(store.read()),
      projectTypes: PROJECT_TYPES
    }),

    changeProjectTemplateRequirement: input => store.update(db => changeProjectTemplateRequirement(db, input)),

    changeProject(user, {
      action, projectId, id, name, stage, newName, description, device_type: deviceType, project_type: projectType,
      project_manager: manager, npi_manager_id: npiId, initiation_files: initiationFiles, initiation_requirements: initiationRequirements = []
    } = {}) {
      if (!['create', 'update', 'rename', 'remove'].includes(action)) throw new RequestError(400, '项目操作无效。');
      if (action === 'create') {
        name = optionalText(name);
        deviceType = optionalText(deviceType);
        projectType = optionalText(projectType) || DEFAULT_PROJECT_TYPE;
        manager = optionalText(manager);
        if (!name) throw new RequestError(400, '请填写项目名称。');
        if (!deviceType) throw new RequestError(400, '请填写或选择设备类型。');
        if (!PROJECT_TYPES.includes(projectType)) throw new RequestError(400, '请选择有效的项目类型。');
        if (!manager) throw new RequestError(400, '请选择项目经理。');
        if (!validId(npiId)) throw new RequestError(400, '请选择 NPI。');
        if (initiationFiles !== undefined && (!initiationFiles || typeof initiationFiles !== 'object' || Array.isArray(initiationFiles))) {
          throw new RequestError(400, '立项文件参数无效。');
        }
        if (!Array.isArray(initiationRequirements) || (projectType === 'SKD' && initiationRequirements.length)) {
          throw new RequestError(400, '新增立项需求参数无效。');
        }
      }
      let nextName;
      if (action === 'rename') {
        nextName = optionalText(newName, 100);
        if (!nextName) throw new RequestError(400, '请填写新的项目名称。');
      }
      if (action === 'update') {
        if (stage !== undefined) {
          if (stage !== null && typeof stage !== 'string') throw new RequestError(400, '请选择项目阶段。');
        }
        if (description !== undefined) description = optionalText(description, 10000);
        if (deviceType !== undefined) deviceType = optionalText(deviceType);
        if (projectType !== undefined) {
          projectType = optionalText(projectType) || DEFAULT_PROJECT_TYPE;
          if (!PROJECT_TYPES.includes(projectType)) throw new RequestError(400, '请选择有效的项目类型。');
        }
        if (manager !== undefined) manager = optionalText(manager);
        if (npiId !== undefined && npiId !== null && !validId(npiId)) throw new RequestError(400, 'NPI 人员编号无效。');
      }
      let removedAttachments = false;
      const result = store.update(db => {
        db.projects ??= [];
        db.seq.project ??= 1;
        if (action === 'create') {
          const tuple = projectTupleKey(name, deviceType, projectType);
          if (db.projects.some(item => projectTupleKey(item.name, item.device_type, item.project_type) === tuple) ||
              (db.projectApplications ?? []).some(item => item.status === 'pending' && projectTupleKey(item.name, item.device_type, item.project_type) === tuple)) {
            throw new RequestError(409, '相同项目名称、设备类型和项目类型的项目或待审批申请已存在。');
          }
          if (!(db.demandOptions.project_manager ?? []).includes(manager)) {
            throw new RequestError(409, '项目经理已不可选，请刷新后重试。');
          }
          taskMember(db, npiId, 'NPI');
          const firstStage = projectTemplateStages(projectType)[0];
          if (!isDemandApprover(user, db)) {
            db.projectApplications ??= [];
            db.seq.projectApplication ??= 1;
            const appId = db.seq.projectApplication++;
            const cleanedReqs = [];
            for (const item of initiationRequirements) {
              if (!item || typeof item !== 'object' || Array.isArray(item) ||
                  (item.files !== undefined && !Array.isArray(item.files))) {
                throw new RequestError(400, '新增立项需求或交付文件参数无效。');
              }
              const { description: reqDesc, deliverable, planned_hours, step_name, files = [] } = item;
              if (files.length) bindAttachments(db, user, { id: appId }, 'delivery', files, { targetKey: 'project_application_id' });
              cleanedReqs.push({ description: reqDesc ?? '', deliverable: deliverable ?? '', planned_hours: planned_hours ?? null, step_name: step_name ?? '', files });
            }
            const boundInitFiles = {};
            for (const [code, files] of Object.entries(initiationFiles ?? {})) {
              if (!Array.isArray(files) || !files.length) continue;
              bindAttachments(db, user, { id: appId }, 'delivery', files, { targetKey: 'project_application_id' });
              boundInitFiles[code] = files;
            }
            const timestamp = now();
            const applicantName = displayName(db, user);
            const app = {
              id: appId,
              name,
              device_type: deviceType,
              project_type: projectType,
              project_manager: manager,
              npi_manager_id: npiId,
              initiation_files: boundInitFiles,
              initiation_requirements: cleanedReqs,
              applicant_id: user.id,
              applicant_name: applicantName,
              status: 'pending',
              reviewed_by_id: null,
              reviewed_by_name: null,
              reviewed_at: null,
              reject_reason: null,
              created_project_id: null,
              created_at: timestamp,
              updated_at: timestamp
            };
            db.projectApplications.unshift(app);
            notifyUsers(db, demandApproverIds(db), {
              category: 'project_approval',
              event: 'submitted',
              title: `新的项目创建申请：${name}`,
              body: `${applicantName} 申请新建${projectType}「${name}（${deviceType}）」，请前往审批中心处理。`,
              actor_name: applicantName,
              target_type: 'project_application',
              target_id: app.id
            });
            return { ...projectCatalog(db), pendingApproval: true, application: publicProjectApplication(db, app) };
          }
          const project = {
            id: db.seq.project++,
            name,
            stage: firstStage,
            description: null,
            device_type: deviceType,
            project_type: projectType,
            project_manager: manager,
            npi_manager_id: npiId
          };
          db.projects.push(project);
          syncDemandOptionProjects(db);
          const lists = initializeProjectRequirements(db, project.id, project.project_type);
          const filesByCode = { ...initiationFiles };
          for (const item of initiationRequirements) {
            if (!item || typeof item !== 'object' || Array.isArray(item) ||
                (item.files !== undefined && !Array.isArray(item.files))) {
              throw new RequestError(400, '新增立项需求或交付文件参数无效。');
            }
            const { description, deliverable, planned_hours, step_name, files } = item;
            changeProjectRequirement(db, { projectKey: project.id, stage: firstStage, action: 'add',
              description, deliverable, planned_hours, step_name });
            filesByCode[lists[firstStage].rows.at(-1).code] = files;
          }
          syncProjectStageDemands(db, project, firstStage, recordTaskChange, filesByCode, user);
        } else {
          const project = findProject(db, { projectId, id, name });
          if (!project) throw new RequestError(404, '未找到这个项目，请刷新后重试。');
          if (action === 'update') {
            const nextDevice = deviceType !== undefined ? deviceType : project.device_type;
            const nextType = projectType !== undefined ? projectType : (project.project_type || DEFAULT_PROJECT_TYPE);
            const tuple = projectTupleKey(project.name, nextDevice, nextType);
            if (db.projects.some(item => item.id !== project.id && projectTupleKey(item.name, item.device_type, item.project_type) === tuple)) {
              throw new RequestError(409, '相同项目名称、设备类型和项目类型的项目已存在。');
            }
            if (description !== undefined) project.description = description;
            if (deviceType !== undefined) project.device_type = deviceType;
            if (projectType !== undefined && projectType !== project.project_type) {
              project.project_type = projectType;
              const timestamp = now();
              for (const demand of db.demands) {
                if (demand.project_id === project.id || demand.source_project_id === project.id) {
                  demand.project_type = projectType;
                  demand.updated_at = timestamp;
                }
              }
              for (const task of db.tasks) {
                if (task.project_id === project.id) {
                  task.project_type = projectType;
                  task.revision = (task.revision ?? 0) + 1;
                  task.updated_at = timestamp;
                }
              }
            }
            if (manager !== undefined) {
              if (manager !== null && manager !== project.project_manager && !(db.demandOptions.project_manager ?? []).includes(manager)) {
                throw new RequestError(409, '项目经理已不可选，请刷新后重试。');
              }
              project.project_manager = manager;
            }
            if (npiId !== undefined) {
              if (npiId === null) {
                project.npi_manager_id = null;
              } else {
                if (npiId !== project.npi_manager_id) taskMember(db, npiId, 'NPI');
                project.npi_manager_id = npiId;
              }
            }
            if (stage !== undefined) {
              const allowedStages = projectStageOptions(db, project);
              const nextStage = stage ?? allowedStages[0];
              if (!allowedStages.includes(nextStage)) {
                throw new RequestError(409, '项目阶段已不可选，请刷新后重试。');
              }
              const prevStage = project.stage || allowedStages[0];
              project.stage = nextStage;
              if (nextStage !== prevStage) syncProjectStageDemands(db, project, nextStage, recordTaskChange);
            }
          } else if (action === 'rename') {
            if (nextName !== project.name) {
              const tuple = projectTupleKey(nextName, project.device_type, project.project_type);
              if (db.projects.some(item => item.id !== project.id && projectTupleKey(item.name, item.device_type, item.project_type) === tuple)) {
                throw new RequestError(409, '相同项目名称、设备类型和项目类型的项目已存在。');
              }
              const oldName = project.name;
              project.name = nextName;
              syncDemandOptionProjects(db);
              for (const file of db.attachments) {
                if (file.kind === 'project' && file.project_id === project.id) file.project_name = nextName;
              }
              const timestamp = now();
              for (const task of db.tasks) {
                if (task.project_id === project.id) {
                  task.proj = nextName;
                  task.revision = (task.revision ?? 0) + 1;
                  task.updated_at = timestamp;
                }
              }
              for (const demand of db.demands) {
                if (demand.project_id === project.id || demand.source_project_id === project.id) {
                  demand.proj = nextName;
                  if (demand.source_project === oldName) demand.source_project = nextName;
                  demand.updated_at = timestamp;
                }
              }
            }
          } else if (action === 'remove') {
            db.projects = db.projects.filter(item => item.id !== project.id);
            syncDemandOptionProjects(db);
            if (db.projectRequirements) delete db.projectRequirements[String(project.id)];
            for (const file of db.attachments) {
              if (file.kind === 'project' && file.project_id === project.id && file.state === 'bound') {
                file.state = 'deleting';
                removedAttachments = true;
              }
            }
          }
        }
        return projectCatalog(db);
      });
      if (removedAttachments) void cleanupAttachments?.();
      return result;
    },

    listProjectApplications(user) {
      const db = store.read();
      if (!isDemandApprover(user, db)) throw new RequestError(403, '仅超级管理员或指定审批人可以查看项目审批。');
      const applications = (db.projectApplications ?? [])
        .map(app => publicProjectApplication(db, app))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id);
      return { applications };
    },

    reviewProjectApplication(user, { applicationId, decision, reason }) {
      const id = recordId(applicationId);
      if (!['approve', 'reject'].includes(decision)) throw new RequestError(400, '审批操作无效。');
      const rejectReason = decision === 'reject' ? optionalText(reason, 500) : null;
      let removedAttachments = false;
      const result = store.update(db => {
        if (!isDemandApprover(user, db)) throw new RequestError(403, '仅超级管理员或指定审批人可以审批项目申请。');
        const app = (db.projectApplications ?? []).find(item => item.id === id);
        if (!app) throw new RequestError(404, '未找到这条项目申请。');
        if (app.status !== 'pending') throw new RequestError(409, '这条项目申请已审批，无需重复操作。');
        const timestamp = now();
        const reviewerName = displayName(db, user);
        let createdProject = null;
        if (decision === 'approve') {
          db.projects ??= [];
          db.seq.project ??= 1;
          const tuple = projectTupleKey(app.name, app.device_type, app.project_type);
          if (db.projects.some(item => projectTupleKey(item.name, item.device_type, item.project_type) === tuple)) {
            throw new RequestError(409, '相同项目名称、设备类型和项目类型的项目已存在。');
          }
          taskMember(db, app.npi_manager_id, 'NPI');
          const firstStage = projectTemplateStages(app.project_type)[0];
          const project = {
            id: db.seq.project++,
            name: app.name,
            stage: firstStage,
            description: null,
            device_type: app.device_type,
            project_type: app.project_type,
            project_manager: app.project_manager,
            npi_manager_id: app.npi_manager_id
          };
          db.projects.push(project);
          syncDemandOptionProjects(db);
          const lists = initializeProjectRequirements(db, project.id, project.project_type);
          const filesByCode = { ...(app.initiation_files ?? {}) };
          for (const item of app.initiation_requirements ?? []) {
            const { description: reqDesc, deliverable, planned_hours, step_name, files } = item;
            changeProjectRequirement(db, { projectKey: project.id, stage: firstStage, action: 'add',
              description: reqDesc, deliverable, planned_hours, step_name });
            filesByCode[lists[firstStage].rows.at(-1).code] = files;
          }
          syncProjectStageDemands(db, project, firstStage, recordTaskChange, filesByCode, user);
          app.created_project_id = project.id;
          createdProject = projectSummary(db, project);
        } else {
          for (const file of db.attachments) {
            if (file.project_application_id === app.id && file.state === 'bound') {
              file.state = 'deleting';
              removedAttachments = true;
            }
          }
        }
        app.status = decision === 'approve' ? 'approved' : 'rejected';
        app.reviewed_by_id = user.id;
        app.reviewed_by_name = reviewerName;
        app.reviewed_at = timestamp;
        app.reject_reason = rejectReason;
        app.updated_at = timestamp;
        if (validId(app.applicant_id)) {
          notifyUsers(db, [app.applicant_id], {
            category: 'project_approval',
            event: decision === 'approve' ? 'approved' : 'rejected',
            title: decision === 'approve' ? `新建项目申请已通过：${app.name}` : `新建项目申请已驳回：${app.name}`,
            body: decision === 'approve'
              ? `${reviewerName} 已审批通过你申请新建的${app.project_type}「${app.name}（${app.device_type}）」，项目已自动创建并派发立项任务。`
              : `${reviewerName} 驳回了你申请新建的${app.project_type}「${app.name}（${app.device_type}）」${rejectReason ? `，驳回原因：${rejectReason}` : ''}。`,
            actor_name: reviewerName,
            target_type: decision === 'approve' ? 'project' : 'project_application',
            target_id: decision === 'approve' ? app.created_project_id : app.id
          });
        }
        return {
          application: publicProjectApplication(db, app),
          project: createdProject,
          catalog: projectCatalog(db)
        };
      });
      if (removedAttachments) void cleanupAttachments?.();
      return result;
    },

    extendTask(user, { taskId, extendHours, reason, expectedVersion }) {
      const id = recordId(taskId);
      const hours = Number(extendHours);
      if (!Number.isFinite(hours) || hours < 0.01 || hours !== Number(hours.toFixed(2))) {
        throw new RequestError(400, '请填写有效的延长小时数，最小 0.01 小时，最多两位小数。');
      }
      const extReason = optionalText(reason, 500);
      if (!extReason) throw new RequestError(400, '请填写延期原因。');
      const result = store.update(db => {
        const task = db.tasks.find(item => item.id === id);
        if (!task || !visibleTask(user, task)) throw new RequestError(404, '未找到此任务。');
        if (!canExtendTask(db, user, task)) {
          throw new RequestError(403, '仅该任务的派发人或审批人可以延长交期，且任务须处于进行中并已规划。');
        }
        if (expectedVersion != null && Number.isSafeInteger(expectedVersion) && (task.revision ?? 0) !== expectedVersion) {
          throw new RequestError(409, '任务已变化，请刷新后重试。');
        }
        db.taskExtensions ??= [];
        const hasPending = db.taskExtensions.some(item => item.task_id === task.id && item.status === 'pending');
        const isApprover = isDemandApprover(user, db);
        if (hasPending) {
          throw new RequestError(409, isApprover
            ? '该任务已有待审批的延期申请，请先前往审批中心处理。'
            : '该任务已有待审批的延期申请，请等待审批完成后再操作。');
        }
        const prevDue = task.planned_due_at;
        const newDue = plannedCompletion(prevDue, hours, '立即');
        if (!newDue) throw new RequestError(400, '延长时间超出可计算范围，请重新填写。');
        const prevPlannedHours = Number(task.planned_hours) || 0;
        const newPlannedHours = Number((prevPlannedHours + hours).toFixed(2));
        const timestamp = now();
        const actorName = displayName(db, user);

        if (isApprover) {
          task.planned_hours = newPlannedHours;
          task.planned_due_at = newDue;
          task.revision = (task.revision ?? 0) + 1;
          task.updated_at = timestamp;
          appendTaskHistory(db, user, task.id,
            `延长交期（+${hours}h，计划投入工时：${prevPlannedHours}h → ${newPlannedHours}h，计划完成时间：${formatPlanningTime(prevDue)} → ${formatPlanningTime(newDue)}，原因：${extReason}）`);
          if (validId(task.assignee_id) && task.assignee_id !== user.id) {
            notifyUsers(db, [task.assignee_id], {
              category: 'task_notice',
              event: 'extended',
              title: `任务交期已延长：${task.code}`,
              body: `${actorName} 已将任务「${task.code}」${task.proj ? `（${task.proj}）` : ''}交期延长 ${hours}h，新计划完成时间：${formatPlanningTime(newDue)}，原因：${extReason}。`,
              actor_name: actorName,
              target_type: 'task',
              target_id: task.id
            });
          }
          return { applied: true, task: publicTask(db, user, task) };
        }

        db.seq.taskExtension ??= 1;
        const app = {
          id: db.seq.taskExtension++,
          task_id: task.id,
          task_code: task.code,
          proj: task.proj ?? null,
          owner_name: taskOwnerName(db, task) || null,
          assignee_id: task.assignee_id ?? null,
          extend_hours: hours,
          reason: extReason,
          prev_planned_hours: prevPlannedHours,
          new_planned_hours: newPlannedHours,
          prev_planned_due_at: prevDue,
          new_planned_due_at: newDue,
          applicant_id: user.id,
          applicant_name: actorName,
          status: 'pending',
          reviewed_by_id: null,
          reviewed_by_name: null,
          reviewed_at: null,
          reject_reason: null,
          created_at: timestamp,
          updated_at: timestamp
        };
        db.taskExtensions.unshift(app);
        notifyUsers(db, demandApproverIds(db), {
          category: 'task_extension',
          event: 'submitted',
          title: `新的延期审批申请：${task.code}`,
          body: `${actorName} 申请将任务「${task.code}」${task.proj ? `（${task.proj}）` : ''}交期延长 ${hours}h（预计调整至 ${formatPlanningTime(newDue)}），原因：${extReason}，请前往审批中心处理。`,
          actor_name: actorName,
          target_type: 'task_extension',
          target_id: app.id
        });
        return { applied: false, application: publicTaskExtension(db, app), task: publicTask(db, user, task) };
      });
      return result;
    },

    listTaskExtensions(user) {
      const db = store.read();
      if (!isDemandApprover(user, db)) throw new RequestError(403, '仅超级管理员或指定审批人可以查看延期审批。');
      const applications = (db.taskExtensions ?? [])
        .map(app => publicTaskExtension(db, app))
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id);
      return { applications };
    },

    reviewTaskExtension(user, { applicationId, decision, reason }) {
      const id = recordId(applicationId);
      if (!['approve', 'reject'].includes(decision)) throw new RequestError(400, '审批操作无效。');
      const rejectReason = decision === 'reject' ? optionalText(reason, 500) : null;
      return store.update(db => {
        if (!isDemandApprover(user, db)) throw new RequestError(403, '仅超级管理员或指定审批人可以审批延期申请。');
        const app = (db.taskExtensions ?? []).find(item => item.id === id);
        if (!app) throw new RequestError(404, '未找到这条延期申请。');
        if (app.status !== 'pending') throw new RequestError(409, '这条延期申请已审批，无需重复操作。');
        const timestamp = now();
        const reviewerName = displayName(db, user);
        let updatedTask = null;
        if (decision === 'approve') {
          const task = db.tasks.find(item => item.id === app.task_id);
          if (!task) throw new RequestError(409, '关联任务已不存在，无法通过延期，请驳回该申请。');
          if (!ACTIVE_TASK_STATUSES.includes(task.status) || !task.planned_due_at) {
            throw new RequestError(409, '关联任务已不在进行中状态，无法通过延期，请驳回该申请。');
          }
          const prevDue = task.planned_due_at;
          const newDue = plannedCompletion(prevDue, app.extend_hours, '立即');
          if (!newDue) throw new RequestError(400, '延长时间超出可计算范围，请驳回该申请。');
          const prevPlannedHours = Number(task.planned_hours) || 0;
          const newPlannedHours = Number((prevPlannedHours + app.extend_hours).toFixed(2));
          task.planned_hours = newPlannedHours;
          task.planned_due_at = newDue;
          task.revision = (task.revision ?? 0) + 1;
          task.updated_at = timestamp;
          app.prev_planned_hours = prevPlannedHours;
          app.new_planned_hours = newPlannedHours;
          app.prev_planned_due_at = prevDue;
          app.new_planned_due_at = newDue;
          appendTaskHistory(db, user, task.id,
            `延长交期（+${app.extend_hours}h，计划投入工时：${prevPlannedHours}h → ${newPlannedHours}h，计划完成时间：${formatPlanningTime(prevDue)} → ${formatPlanningTime(newDue)}，申请人：${app.applicant_name || '—'}，审批人：${reviewerName}，原因：${app.reason}）`);
          updatedTask = task;
        }
        app.status = decision === 'approve' ? 'approved' : 'rejected';
        app.reviewed_by_id = user.id;
        app.reviewed_by_name = reviewerName;
        app.reviewed_at = timestamp;
        app.reject_reason = rejectReason;
        app.updated_at = timestamp;

        if (decision === 'approve') {
          if (validId(app.applicant_id) && app.applicant_id !== user.id) {
            notifyUsers(db, [app.applicant_id], {
              category: 'task_extension',
              event: 'approved',
              title: `延期申请已通过：${app.task_code}`,
              body: `${reviewerName} 已通过你对任务「${app.task_code}」${app.proj ? `（${app.proj}）` : ''}的延期申请（+${app.extend_hours}h），新计划完成时间：${formatPlanningTime(app.new_planned_due_at)}。`,
              actor_name: reviewerName,
              target_type: 'task',
              target_id: app.task_id
            });
          }
          if (updatedTask && validId(updatedTask.assignee_id) && updatedTask.assignee_id !== user.id && updatedTask.assignee_id !== app.applicant_id) {
            notifyUsers(db, [updatedTask.assignee_id], {
              category: 'task_notice',
              event: 'extended',
              title: `任务交期已延长：${updatedTask.code}`,
              body: `${app.applicant_name || '管理员'} 申请并经 ${reviewerName} 审批通过，任务「${updatedTask.code}」${updatedTask.proj ? `（${updatedTask.proj}）` : ''}交期延长 ${app.extend_hours}h，新计划完成时间：${formatPlanningTime(app.new_planned_due_at)}，原因：${app.reason}。`,
              actor_name: reviewerName,
              target_type: 'task',
              target_id: updatedTask.id
            });
          }
        } else if (validId(app.applicant_id) && app.applicant_id !== user.id) {
          const taskExists = db.tasks.some(t => t.id === app.task_id);
          notifyUsers(db, [app.applicant_id], {
            category: 'task_extension',
            event: 'rejected',
            title: `延期申请已驳回：${app.task_code}`,
            body: `${reviewerName} 驳回了你对任务「${app.task_code}」${app.proj ? `（${app.proj}）` : ''}的延期申请（+${app.extend_hours}h）${rejectReason ? `，驳回原因：${rejectReason}` : ''}。`,
            actor_name: reviewerName,
            target_type: taskExists ? 'task' : null,
            target_id: taskExists ? app.task_id : null
          });
        }
        return {
          application: publicTaskExtension(db, app),
          task: updatedTask ? publicTask(db, user, updatedTask) : null
        };
      });
    },

    listMessages(user) {
      const db = store.read();
      const messages = (db.messages ?? [])
        .filter(item => item.recipient_id === user.id)
        .sort((a, b) => (b.created_at || '').localeCompare(a.created_at || '') || b.id - a.id);
      const unreadCount = messages.filter(item => !item.read_at).length;
      return { messages, unreadCount };
    },

    markMessagesRead(user, { id, all } = {}) {
      const targetId = id != null ? recordId(id) : null;
      return store.update(db => {
        const timestamp = now();
        for (const item of db.messages ?? []) {
          if (item.recipient_id !== user.id || item.read_at) continue;
          if (all === true || (targetId != null && item.id === targetId)) {
            item.read_at = timestamp;
          }
        }
        const unreadCount = (db.messages ?? []).filter(item => item.recipient_id === user.id && !item.read_at).length;
        return { unreadCount };
      });
    },

    appendProjectAttachments(user, { projectId, id, name, files }) {
      if (!isAdmin(user)) throw new RequestError(403, '仅管理员可以上传项目文件。');
      if (!Array.isArray(files) || !files.length) throw new RequestError(400, '请至少选择一个文件。');
      const project = store.update(db => {
        const found = findProject(db, { projectId, id, name });
        if (!found) throw new RequestError(404, '未找到此项目。');
        bindAttachments(db, user, { id: found.id }, 'project', files, { targetKey: 'project_id', extra: { project_name: found.name } });
        return found;
      });
      return { attachments: projectAttachments(store.read(), project) };
    },

    deleteProjectAttachment(user, { projectId, id, name, fileId }) {
      if (!isAdmin(user)) throw new RequestError(403, '仅管理员可以删除项目文件。');
      if (typeof fileId !== 'string' || !fileId.trim()) throw new RequestError(400, '文件编号无效。');
      const project = store.update(db => {
        const found = findProject(db, { projectId, id, name });
        if (!found) throw new RequestError(404, '未找到此项目。');
        const file = db.attachments.find(item => item.kind === 'project' &&
          (item.project_id === found.id || (item.project_id == null && item.project_name === found.name)) &&
          item.id === fileId && item.state === 'bound');
        if (!file) throw new RequestError(404, '未找到这份项目文件。');
        file.state = 'deleting';
        return found;
      });
      void cleanupAttachments?.();
      return { attachments: projectAttachments(store.read(), project) };
    },

    projectAttachmentForDownload(_user, fileId) {
      const file = store.read().attachments.find(item => item.kind === 'project' && item.id === fileId && item.state === 'bound');
      if (!file) throw new RequestError(404, '未找到这份项目文件。');
      return file;
    },

    changeDemandOptions({ kind, action, name }) {
      if (!catalogKinds.has(kind) || !['add', 'remove'].includes(action)) {
        throw new RequestError(400, '基础配置选项操作无效。');
      }
      name = optionalText(name);
      if (!name) throw new RequestError(400, '请填写名称。');
      return store.update(db => {
        const list = (db.demandOptions[kind] ??= []);
        const index = list.indexOf(name);
        if (action === 'add') {
          if (index !== -1) throw new RequestError(409, '这个选项已存在。');
          list.push(name);
        } else if (index !== -1) {
          list.splice(index, 1);
        }
        return { options: db.demandOptions };
      });
    },

    appendTaskAttachments(user, { taskId, kind, files }) {
      const id = recordId(taskId);
      attachmentKind(kind);
      if (!Array.isArray(files) || !files.length) throw new RequestError(400, '请至少选择一个文件。');
      const task = store.update(db => {
        const row = db.tasks.find(item => item.id === id && visibleTask(user, item));
        if (!row) throw new RequestError(404, '未找到此任务。');
        if (!canAppendAttachment(user, row, kind)) throw new RequestError(403, '你没有权限补传此类文件。');
        bindAttachments(db, user, row, kind, files);
        const label = kind === 'requirement' ? '需求文件' : '交付文件';
        appendTaskHistory(db, user, row.id, `上传${label}：${files.map(file => file.name).join('、')}`);
        return row;
      });
      return { task: publicTask(store.read(), user, task) };
    },

    deleteTaskAttachment(user, { taskId, fileId }) {
      const id = recordId(taskId);
      if (typeof fileId !== 'string' || !fileId.trim()) throw new RequestError(400, '文件编号无效。');
      const task = store.update(db => {
        const row = db.tasks.find(item => item.id === id && visibleTask(user, item));
        if (!row) throw new RequestError(404, '未找到此任务。');
        if (!canDeleteDeliveryAttachment(user, row)) throw new RequestError(403, '你没有权限删除交付文件。');
        const file = db.attachments.find(item => item.task_id === id && item.id === fileId &&
          item.kind === 'delivery' && item.state === 'bound');
        if (!file) throw new RequestError(404, '未找到这份交付文件。');
        file.state = 'deleting';
        row.revision = (row.revision ?? 0) + 1;
        row.updated_at = now();
        appendTaskHistory(db, user, row.id, `删除交付文件：${file.name}`);
        return row;
      });
      void cleanupAttachments?.();
      return { task: publicTask(store.read(), user, task) };
    },

    listTaskHistory(user, { taskId }) {
      const db = store.read();
      const task = taskForComments(db, user, recordId(taskId));
      const rows = db.taskHistory?.[task.id]?.rows ?? [];
      return { history: [...rows].reverse() };
    },

    appendDemandAttachments(user, { demandId, files }) {
      const id = recordId(demandId);
      if (!Array.isArray(files) || !files.length) throw new RequestError(400, '请至少选择一个文件。');
      const demand = store.update(db => {
        const row = db.demands.find(item => item.id === id);
        if (!row) throw new RequestError(404, '未找到此需求。');
        if (!canManageDemandFiles(db, user, row)) throw new RequestError(403, '只有委托派发人、创建人或审批管理员可以上传需求文件。');
        const linkedTask = db.tasks.find(task => task.demand_id === id);
        bindAttachments(db, user, row, 'requirement', files, {
          targetKey: 'demand_id',
          extra: linkedTask ? { task_id: linkedTask.id } : {}
        });
        if (linkedTask) {
          const names = files.map(file => file.name).join('、');
          appendTaskHistory(db, user, linkedTask.id, `上传需求文件：${names}`);
          if (validId(linkedTask.assignee_id) && linkedTask.assignee_id !== user.id) {
            const actorName = displayName(db, user);
            notifyUsers(db, [linkedTask.assignee_id], {
              category: 'task_notice',
              event: 'demand_files_added',
              title: `需求补传了新文件：${row.code}`,
              body: `${actorName} 为你负责的任务「${linkedTask.code}」关联需求「${row.code}」补传了文件：${names}。`,
              actor_name: actorName,
              target_type: 'task',
              target_id: linkedTask.id
            });
          }
        }
        return row;
      });
      return { demand: publicRecord(store.read(), user, 'demands', demand) };
    },

    deleteDemandAttachment(user, { demandId, fileId }) {
      const id = recordId(demandId);
      if (typeof fileId !== 'string' || !fileId.trim()) throw new RequestError(400, '文件编号无效。');
      const demand = store.update(db => {
        const row = db.demands.find(item => item.id === id);
        if (!row) throw new RequestError(404, '未找到此需求。');
        if (!canManageDemandFiles(db, user, row)) throw new RequestError(403, '只有委托派发人、创建人或审批管理员可以删除需求文件。');
        const linkedTasks = db.tasks.filter(task => task.demand_id === id);
        const linkedIds = new Set(linkedTasks.map(task => task.id));
        const file = db.attachments.find(item => item.id === fileId && item.kind === 'requirement' && item.state === 'bound' &&
          (item.demand_id === id || linkedIds.has(item.task_id)));
        if (!file) throw new RequestError(404, '未找到这份需求文件。');
        file.state = 'deleting';
        for (const task of linkedTasks) {
          if (file.task_id === task.id) {
            task.revision = (task.revision ?? 0) + 1;
            task.updated_at = now();
            appendTaskHistory(db, user, task.id, `删除需求文件：${file.name}`);
          }
        }
        return row;
      });
      void cleanupAttachments?.();
      return { demand: publicRecord(store.read(), user, 'demands', demand) };
    },

    demandAttachmentForDownload(user, demandId, fileId) {
      const id = recordId(demandId);
      const db = store.read();
      const demand = db.demands.find(row => row.id === id);
      const linkedTasks = demand ? db.tasks.filter(task => task.demand_id === id) : [];
      if (!demand || !readableDemand(user, demand, linkedTasks)) throw new RequestError(404, '未找到此需求。');
      const file = demandRequirementAttachments(db, id, linkedTasks).find(row => row.id === fileId);
      if (!file) throw new RequestError(404, '这条需求没有这份可下载的文件。');
      return file;
    },

    attachmentForDownload(user, taskId, fileId) {
      const id = recordId(taskId);
      const db = store.read();
      const task = db.tasks.find(row => row.id === id && readableTask(db, user, row));
      const file = task && db.attachments.find(row => row.task_id === id && row.state === 'bound' &&
        (fileId ? row.id === fileId : row.kind === 'legacy' && row.id === task.attachment_path));
      if (!file) throw new RequestError(404, '这条任务没有这份可下载的文件。');
      return file;
    }
  };
}

function applyPatch(db, user, table, row, patch, recordTaskChange, creating = false) {
  const before = table === 'tasks' && recordTaskChange ? {
    creating, owner: row.assignee_id
  } : null;
  if (table === 'tasks') {
    applyTaskAssignee(db, row, patch);
    row.revision = (row.revision ?? 0) + 1;
    if (!creating && row.demand_id != null) delete patch.proj;
  }
  Object.assign(row, patch, { updated_at: now() });
  if (table === 'profiles') {
    if (!row.display_name) throw new RequestError(400, '请填写姓名。');
    row.owner_name = row.display_name;
  }
  if (table === 'tasks' && !statuses.includes(row.status)) throw new RequestError(400, '任务状态无效。');
  if (before) recordTaskChange(db, row, before);
  return { row };
}

import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { attachmentKind, bindAttachments } from './attachments.mjs';
import { isAdmin, isPrimaryAdmin, now, optionalText } from './accounts.mjs';
import { changeProjectRequirement, initializeProjectRequirements, projectRequirementRows } from './project-requirements.mjs';
import { RequestError } from './store.mjs';
import { ACTIVE_TASK_STATUSES, normalizeTaskPriority, plannedCompletion, TASK_PRIORITIES } from '../public/task-planning.mjs';

const fields = {
  profiles: { display_name: 100, emp_no: 100, role: 100, team: 100, status: 20, contact: 200, duty: 10000, remark: 10000 },
  tasks: {
    proj: 100, owner_name: 100, assignee_id: 0, status: 20, pri: 20, due: 10, start: 10, end: 10,
    category: 100, device_type: 100,
    start_time: 10, end_time: 10, hours: 0, planned_hours: 0, result: 10000, desc: 10000
  },
  demands: { proj: 100, descr: 10000, proposer: 100 }
};
const sequence = { profiles: 'profile', tasks: 'task', demands: 'demand' };
const statuses = ['待规划', ...ACTIVE_TASK_STATUSES, '已完成'];
const defaultPriority = '中';
const catalogKinds = new Set(['proposer', 'category', 'device_type', 'project_stage']);
const taskProgressFields = new Set(['status', 'result']);
const taskScheduleFields = ['due', 'start', 'end', 'start_time', 'end_time', 'planned_hours', 'started_at', 'planned_due_at', 'completed_at'];
const taskClassificationFields = ['pri', 'category', 'device_type'];
const retiredCollaboratorFields = ['collaborators', 'collaborator_ids', 'add_collaborator_ids', 'keep_as_collaborator'];
const recordCodeDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
});
const taskCommentPageSize = 10;

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
    } else if (key === 'assignee_id') {
      if (value !== null && !validId(value)) throw new RequestError(400, '负责人编号无效。');
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
  if (payload.task_kind !== 'L' && payload.task_kind !== 'W') {
    throw new RequestError(400, '请选择临时任务或工作任务。');
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

function projectStage(db, name) {
  const assignedStages = db.projectStages ?? {};
  return name != null && Object.hasOwn(assignedStages, name) ? assignedStages[name] : null;
}

function projectCatalog(db) {
  return {
    projects: db.demandOptions.proj.map(name => ({ name, stage: projectStage(db, name) })),
    stages: db.demandOptions.project_stage
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
  const { title, dispatch_key, collaborators, transfer_history, revision, requirement_owner_id, ...row } = task;
  if (Object.hasOwn(row, 'pri')) row.pri = normalizeTaskPriority(row.pri);
  if (demand) row.proj = demand.proj ?? null;
  if (dispatch_key || row.demand_id != null || Object.hasOwn(row, 'initial_receiver_id')) {
    row.dispatched_at = row.created_at ?? null;
  }
  const handledAt = taskHandledAt(user, task);
  return { ...row, owner_name: taskOwnerName(db, task), version: revision ?? 0,
    attachments: files.map(({ id, kind, name, size }) => ({ id, kind, name, size })),
    canAppendRequirement: canAppendAttachment(user, task, 'requirement'),
    canAppendDelivery: canAppendAttachment(user, task, 'delivery'),
    project_stage: projectStage(db, row.proj), handled_by_me: handledAt !== null, handled_at: handledAt || null };
}

function directoryProfile({ id, display_name, emp_no, team, role, status }) {
  return { id, display_name, emp_no, team, role, status };
}

function publicDemand(db, user, row, linkedTasks) {
  const assigned = db.profiles.find(profile => profile.owner_id === row.responsible_id);
  return { ...row, responsible: assigned?.display_name || row.responsible || null, linked_tasks: linkedTasks.map(task => {
    const summary = { owner_name: taskOwnerName(db, task), initial_receiver_name: task.initial_receiver_name, status: task.status };
    return visibleTask(user, task) ? { ...summary, id: task.id, code: task.code } : summary;
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

function canAppendAttachment(user, task, kind) {
  if (kind === 'requirement') {
    const fromDemand = task.demand_id != null || Object.hasOwn(task, 'initial_receiver_id');
    return fromDemand && (isAdmin(user) || task.requirement_owner_id === user.id);
  }
  return task.status === '已完成' && (managesRecord(user, task) || task.assignee_id === user.id);
}

function taskForComments(db, user, taskId) {
  const task = db.tasks.find(row => row.id === taskId);
  if (!task || !visibleTask(user, task)) throw new RequestError(404, '未找到此任务。');
  return task;
}

function canCommentOnTask(db, user, task) {
  return task.status !== '已完成' && changeable(db, user, 'tasks', task, 'update', {});
}

function changeable(db, user, table, row, op, patch) {
  if (table === 'profiles') {
    if (row.owner_id === user.id) return op !== 'delete';
    return isAdmin(user) && !db.users.some(account => account.id === row.owner_id && isPrimaryAdmin(account));
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
  if (table === 'demands') assignCode(db.demandCodeSequences ??= {}, row, 'FAE', Date.now());
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
    if (!changeable(db, user, 'tasks', task, 'update', {})) throw new RequestError(403, '你没有权限规划此任务。');
    if (task.status !== '待规划') throw new RequestError(409, '任务已不在待规划状态，请刷新后查看。');
    return task;
  }

  function planningSignature(user, task, minute) {
    return createHmac('sha256', planningKey).update(JSON.stringify([user.id, task, minute])).digest();
  }

  const needsDemandCode = demand => !demand.code;
  const needsReceiver = task => task.demand_id != null && !Object.hasOwn(task, 'initial_receiver_id');
  const needsRequirementOwner = task => task.demand_id != null && !Object.hasOwn(task, 'requirement_owner_id');
  const { demands, tasks } = store.read();
  if (demands.some(needsDemandCode) || tasks.some(task => needsReceiver(task) || needsRequirementOwner(task) || !task.code)) {
    store.update(db => {
      const fallback = Date.now();
      for (const demand of db.demands.filter(needsDemandCode).sort((a, b) => a.id - b.id)) {
        assignCode(db.demandCodeSequences ??= {}, demand, 'FAE', fallback);
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
    });
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
          const demands = new Map(db.demands.map(demand => [demand.id, demand]));
          const attachments = new Map();
          for (const file of db.attachments) {
            if (file.state !== 'bound') continue;
            if (!attachments.has(file.task_id)) attachments.set(file.task_id, []);
            attachments.get(file.task_id).push(file);
          }
          return {
            data: db.tasks.filter(task => visibleTask(user, task))
              .map(task => publicTask(db, user, task, demands.get(task.demand_id) ?? null, attachments.get(task.id) ?? [])),
            taskCategories: db.demandOptions.category
          };
        }
        if (table === 'demands') {
          const links = new Map();
          for (const task of db.tasks) {
            if (task.demand_id == null) continue;
            if (!links.has(task.demand_id)) links.set(task.demand_id, []);
            links.get(task.demand_id).push(task);
          }
          return { data: db.demands.map(row => publicDemand(db, user, row, links.get(row.id) || [])) };
        }
        return { data: db[table] };
      }
      const id = op === 'insert' ? null : recordId(Array.isArray(eq) && eq[0] === 'id' ? eq[1] : null);
      const patch = op === 'delete' ? {} : cleanFields(table, payload);
      let extra;
      if (table === 'tasks' && op !== 'delete') {
        checkTaskPeople(payload, op === 'insert');
        if (op === 'update') {
          checkTaskSchedule(payload);
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
          if (!changeable(db, user, table, list[index], op, patch)) throw new RequestError(403, '你没有权限修改或删除这条记录。');
          if (table === 'tasks' && list[index].status === '已完成') {
            if (op === 'update') throw new RequestError(409, '任务已完成，无法修改。');
            if (!isAdmin(user)) throw new RequestError(403, '只有管理员可以删除已完成的任务。');
          }
          if (op === 'delete') {
            if (table === 'demands') {
              const linked = db.tasks.filter(task => task.demand_id === id);
              if (linked.length && !isAdmin(user)) throw new RequestError(403, '已派发的需求只能由管理员删除。');
              for (const task of linked) {
                Object.assign(task, { proj: list[index].proj ?? null, demand_id: null, revision: (task.revision ?? 0) + 1 });
              }
            }
            const [row] = list.splice(index, 1);
            if (table === 'tasks') {
              delete db.taskComments?.[row.id];
              for (const file of db.attachments) if (file.task_id === row.id) file.state = 'deleting';
            }
            return { row };
          }
          if (table === 'tasks') {
            const current = list[index].status;
            if (Object.hasOwn(patch, 'status') && patch.status !== current &&
                !(ACTIVE_TASK_STATUSES.includes(current) && ACTIVE_TASK_STATUSES.includes(patch.status))) {
              throw new RequestError(409, '任务状态只能在开发中和测试中切换。开始任务请使用开始规划。');
            }
          }
          return applyPatch(db, user, table, list[index], patch, recordTaskChange);
        }
        return insertRecord(db, user, table, patch, recordTaskChange, extra);
      });
      if (table === 'tasks' && op === 'delete') void cleanupAttachments?.();
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
        Object.assign(patch, { status: '开发中', started_at: startedAt, planned_hours: plannedHours, planned_due_at: due });
        return applyPatch(db, user, 'tasks', task, patch, recordTaskChange);
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
      if (Object.hasOwn(patch, 'status') || Object.hasOwn(patch, 'hours')) {
        throw new RequestError(400, '任务状态和投入工时由完成操作记录。');
      }

      const { row } = store.update(db => {
        const task = db.tasks.find(item => item.id === id);
        if (!task || !visibleTask(user, task)) throw new RequestError(404, '未找到此任务。');
        if (!changeable(db, user, 'tasks', task, 'update', patch)) {
          throw new RequestError(403, '你没有权限完成此任务或修改这些任务信息。');
        }
        if (!ACTIVE_TASK_STATUSES.includes(task.status)) {
          throw new RequestError(409, '只有开发中或测试中的任务可以完成，请刷新后查看。');
        }
        if ((task.revision ?? 0) !== expectedVersion) throw new RequestError(409, '任务已变化，请重新打开更新任务后重试。');
        bindAttachments(db, user, task, 'delivery', files);
        Object.assign(patch, { status: '已完成', hours, completed_at: now() });
        return applyPatch(db, user, 'tasks', task, patch, recordTaskChange);
      });
      return { task: publicTask(store.read(), user, row) };
    },

    dispatchDemand(user, { demandId, dispatchKey, task, files }) {
      const id = recordId(demandId);
      if (typeof dispatchKey !== 'string' || !/^[a-f0-9-]{36}$/.test(dispatchKey)) throw new RequestError(400, '派发编号无效。');
      const patch = newTaskPatch(cleanFields('tasks', task));
      checkTaskPeople(task, true);
      if (!patch.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');
      if (!optionalText(task.pri, fields.tasks.pri)) throw new RequestError(400, '请选择优先级。');
      if (!patch.category) throw new RequestError(400, '请填写工单分类。');
      if (!patch.device_type) throw new RequestError(400, '请填写设备类型。');
      const kind = taskKind(task);

      const { created, demand } = store.update(db => {
        const source = db.demands.find(row => row.id === id);
        if (!source) throw new RequestError(404, '未找到此需求。');
        if (!managesRecord(user, source)) throw new RequestError(403, '只有管理员或需求创建人可以派发任务。');
        const existing = db.tasks.find(row => row.demand_id === id);
        if (existing) {
          if (existing.creator_id === user.id && existing.dispatch_key === dispatchKey) return { created: existing, demand: source };
          throw new RequestError(409, '这条需求已经派发。');
        }
        const details = { desc: source.descr ?? null, ...patch, proj: source.proj ?? null };
        const row = insertRecord(db, user, 'tasks', details, recordTaskChange, {
          demand_id: id, dispatch_key: dispatchKey, task_kind: kind,
          requirement_owner_id: source.creator_id ?? source.owner_id
        }).row;
        bindAttachments(db, user, row, 'requirement', files);
        row.initial_receiver_id = row.assignee_id;
        row.initial_receiver_name = row.owner_name;
        return { created: row, demand: source };
      });
      const db = store.read();
      return { task: publicTask(db, user, created, demand), demand: publicRecord(db, user, 'demands', demand) };
    },

    transferTask(user, { taskId, assignee_id: assigneeId, expectedVersion }) {
      const id = recordId(taskId);
      if (!validId(assigneeId) || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) {
        throw new RequestError(400, '请选择接手人并刷新任务后重试。');
      }
      const { row } = store.update(db => {
        const task = db.tasks.find(item => item.id === id);
        if (!task || !visibleTask(user, task)) throw new RequestError(404, '未找到此任务。');
        if ((task.revision ?? 0) !== expectedVersion) throw new RequestError(409, '任务已变化，请刷新后重新转交。');
        if (!isAdmin(user) && task.assignee_id !== user.id) throw new RequestError(403, '只有当前负责人或管理员可以转交任务。');
        if (task.status === '已完成') throw new RequestError(409, '已完成的任务不能转交。');
        if (task.assignee_id === assigneeId) throw new RequestError(400, '请选择其他成员接手任务。');
        task.transfer_history ??= [];
        task.transfer_history.push({ from_id: task.assignee_id ?? null, to_id: assigneeId, at: now() });
        return applyPatch(db, user, 'tasks', task, { assignee_id: assigneeId }, recordTaskChange);
      });
      return { task: publicTask(store.read(), user, row) };
    },

    demandChoices() {
      const db = store.read();
      const users = new Map(db.users.map(user => [user.id, user]));
      const people = db.profiles.filter(profile => profile.status !== '已离职' && profile.display_name && users.has(profile.owner_id))
        .map(profile => {
          const user = users.get(profile.owner_id);
          return { id: user.id, name: profile.display_name, emp_no: profile.emp_no || user.account, is_admin: isAdmin(user) };
        });
      return { options: db.demandOptions, people };
    },

    projectCatalog: () => projectCatalog(store.read()),

    projectDetail(name) {
      const db = store.read();
      if (!db.demandOptions.proj.includes(name)) throw new RequestError(404, '未找到此项目。');
      return {
        project: { name, stage: projectStage(db, name) },
        stages: db.demandOptions.project_stage,
        requirements: projectRequirementRows(db, name)
      };
    },

    changeProjectRequirement: input => store.update(db => changeProjectRequirement(db, input)),

    changeProject({ action, name, stage }) {
      if (!['create', 'update', 'remove'].includes(action)) throw new RequestError(400, '项目操作无效。');
      if (action === 'create') name = optionalText(name);
      if (typeof name !== 'string' || !name) throw new RequestError(400, '请填写项目名称。');
      if (action === 'update' && typeof stage !== 'string' && stage !== null) {
        throw new RequestError(400, '请选择项目阶段。');
      }
      return store.update(db => {
        const names = db.demandOptions.proj;
        const index = names.indexOf(name);
        if (action === 'create') {
          if (index !== -1) throw new RequestError(409, '项目名称已存在。');
          names.push(name);
          initializeProjectRequirements(db, name);
        } else {
          if (index === -1) throw new RequestError(404, '未找到这个项目，请刷新后重试。');
          if (action === 'update' && stage !== null && !db.demandOptions.project_stage.includes(stage)) {
            throw new RequestError(409, '项目阶段已不可选，请刷新后重试。');
          }
          if (action === 'remove') {
            names.splice(index, 1);
            if (db.projectRequirements) delete db.projectRequirements[name];
          }
          if (action === 'update' && stage !== null) {
            db.projectStages = { ...db.projectStages, [name]: stage };
          } else if (db.projectStages) {
            delete db.projectStages[name];
          }
        }
        return projectCatalog(db);
      });
    },

    changeDemandOptions({ kind, action, name }) {
      if (!catalogKinds.has(kind) || !['add', 'remove'].includes(action)) {
        throw new RequestError(400, '基础配置选项操作无效。');
      }
      name = optionalText(name);
      if (!name) throw new RequestError(400, '请填写名称。');
      return store.update(db => {
        const list = db.demandOptions[kind];
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
        return row;
      });
      return { task: publicTask(store.read(), user, task) };
    },

    attachmentForDownload(user, taskId, fileId) {
      const id = recordId(taskId);
      const db = store.read();
      const task = db.tasks.find(row => row.id === id && visibleTask(user, row));
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
  if (table === 'demands' && patch.proposer != null && patch.proposer !== row.proposer &&
      !db.demandOptions.proposer.includes(patch.proposer)) {
    throw new RequestError(409, '需求提出方已不可选，请重新选择。');
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

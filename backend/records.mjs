import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAdmin, isPrimaryAdmin, now, optionalText } from './accounts.mjs';
import { RequestError } from './store.mjs';

const fields = {
  profiles: { display_name: 100, emp_no: 100, role: 100, team: 100, status: 20, contact: 200, duty: 10000, remark: 10000 },
  tasks: {
    title: 180, proj: 100, owner_name: 100, assignee_id: 0, collaborator_ids: 0, status: 20, pri: 20, due: 10, start: 10, end: 10,
    add_collaborator_ids: 0, keep_as_collaborator: 0, category: 100, device_type: 100, project_stage: 100,
    start_time: 10, end_time: 10, hours: 0, planned_hours: 0, result: 10000, desc: 10000, attachment_name: 255, attachment_path: 60
  },
  demands: { title: 180, proj: 100, descr: 10000, proposer: 100 }
};
const sequence = { profiles: 'profile', tasks: 'task', demands: 'demand' };
const statuses = ['待规划', '开发中', '测试中', '已完成'];
const priorities = ['低', '中', '高', '极高'];
const defaultPriority = '中';
const catalogKinds = new Set(['proj', 'proposer', 'category', 'device_type', 'project_stage']);
const taskProgressFields = new Set(['status', 'start', 'end', 'start_time', 'end_time', 'hours', 'result', 'attachment_name', 'attachment_path']);
const taskAssigneeEditFields = new Set(['add_collaborator_ids', 'project_stage']);
const taskClassificationFields = ['pri', 'category', 'device_type'];
const taskHandoverFields = ['assignee_id', 'keep_as_collaborator'];
const expiry = 24 * 60 * 60 * 1000;

function recordId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) throw new RequestError(400, '记录编号无效。');
  return id;
}

const validId = value => Number.isSafeInteger(value) && value > 0;

function cleanFields(table, payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RequestError(400, '没有可保存的内容。');
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
    } else if (key === 'collaborator_ids' || key === 'add_collaborator_ids') {
      if (!Array.isArray(value) || !value.every(validId)) throw new RequestError(400, '合作者名单无效。');
      patch[key] = [...new Set(value)];
    } else if (key === 'keep_as_collaborator') {
      if (typeof value !== 'boolean') throw new RequestError(400, '请选择转交方式。');
      patch[key] = value;
    } else if (key === 'pri') {
      const priority = optionalText(value, maximum) || defaultPriority;
      if (!priorities.includes(priority)) throw new RequestError(400, '任务优先级无效。');
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

function demandTaskFields(demand) {
  return { title: demand.title, proj: demand.proj ?? null };
}

function publicTask(db, task, demand = db.demands.find(row => row.id === task.demand_id)) {
  const { dispatch_key, ...row } = task;
  if (demand) Object.assign(row, demandTaskFields(demand));
  if (dispatch_key || row.demand_id != null || Object.hasOwn(row, 'initial_receiver_id')) {
    row.dispatched_at = row.created_at ?? null;
  }
  return { ...row, owner_name: taskOwnerName(db, task),
    collaborators: (task.collaborators || []).map(person => {
      const user = db.users.find(item => item.id === person.id);
      return user ? { id: person.id, name: displayName(db, user) } : person;
    }) };
}

function directoryProfile({ id, display_name, emp_no, team, role, status }) {
  return { id, display_name, emp_no, team, role, status };
}

function publicDemand(db, user, row, linkedTasks) {
  const assigned = db.profiles.find(profile => profile.owner_id === row.responsible_id);
  return { ...row, responsible: assigned?.display_name || row.responsible || null, linked_tasks: linkedTasks.map(task => {
    const summary = { owner_name: taskOwnerName(db, task), initial_receiver_name: task.initial_receiver_name, status: task.status };
    if (managesRecord(user, row)) {
      Object.assign(summary, { task_id: task.id, assignee_id: task.assignee_id,
        collaborator_ids: (task.collaborators || []).map(person => person.id) });
    }
    return visibleTask(user, task) ? { ...summary, id: task.id, title: row.title } : summary;
  }) };
}

function taskMember(db, id, label) {
  const profile = db.profiles.find(person => person.owner_id === id && person.status !== '已离职');
  if (!profile?.display_name || !db.users.some(user => user.id === id)) {
    throw new RequestError(409, label + '已不可选，请重新选择。');
  }
  return { id, name: profile.display_name };
}

function applyTaskPeople(db, task, patch) {
  const previous = task.assignee_id;
  if (Object.hasOwn(patch, 'assignee_id')) {
    if (patch.assignee_id !== task.assignee_id) {
      const owner = patch.assignee_id === null ? null : taskMember(db, patch.assignee_id, '负责人');
      task.assignee_id = owner?.id ?? null;
      task.owner_name = owner?.name ?? null;
    }
  } else if (Object.hasOwn(patch, 'owner_name')) {
    // Older task clients may still submit the original name or account field.
    if (task.assignee_id == null || taskOwnerName(db, task) !== patch.owner_name) {
      assignTask(db, task, patch.owner_name);
      if (task.demand_id != null && task.assignee_id != null && task.assignee_id !== previous) {
        taskMember(db, task.assignee_id, '负责人');
      }
    }
  }
  if (task.demand_id != null && !task.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');
  if (Object.hasOwn(patch, 'collaborator_ids')) {
    const existing = new Map((task.collaborators || []).map(person => [person.id, person]));
    task.collaborators = patch.collaborator_ids.map(id => existing.get(id) || taskMember(db, id, '合作者'));
  }
  if (task.demand_id != null && previous != null && task.assignee_id !== previous) {
    task.collaborators = (task.collaborators || []).filter(person => person.id !== task.assignee_id);
  } else if (task.collaborators?.some(person => person.id === task.assignee_id)) {
    throw new RequestError(400, '负责人不能同时列为合作者。');
  }
  delete patch.owner_name;
  delete patch.assignee_id;
  delete patch.collaborator_ids;
}

function prepareTaskPeopleUpdate(user, task, patch) {
  const handover = Object.hasOwn(patch, 'keep_as_collaborator');
  if (handover) {
    if (task.assignee_id !== user.id) throw new RequestError(409, '当前负责人已变化，请刷新后重试。');
    if (patch.assignee_id == null || patch.assignee_id === user.id) throw new RequestError(400, '请选择其他成员接手任务。');
  } else if (task.demand_id != null && !isAdmin(user) &&
      (Object.hasOwn(patch, 'assignee_id') || Object.hasOwn(patch, 'owner_name'))) {
    throw new RequestError(403, '只有管理员或当前负责人可以更换派发任务的负责人。');
  }

  const additions = patch.add_collaborator_ids;
  if (handover || additions) {
    const owner = Object.hasOwn(patch, 'assignee_id') ? patch.assignee_id : task.assignee_id;
    const previous = patch.collaborator_ids ?? (task.collaborators || []).map(person => person.id);
    const people = new Set([...previous, ...(additions || [])]);
    people.delete(owner);
    if (handover) {
      people.delete(task.assignee_id);
      if (patch.keep_as_collaborator) people.add(task.assignee_id);
    }
    patch.collaborator_ids = [...people];
  }
  delete patch.keep_as_collaborator;
  delete patch.add_collaborator_ids;
}

function managesRecord(user, row) {
  return isAdmin(user) || (row.creator_id ?? row.owner_id) === user.id;
}

function visibleTask(user, task) {
  return managesRecord(user, task) || task.assignee_id === user.id || task.collaborators?.some(person => person.id === user.id);
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
    Object.keys(patch).every(field => taskProgressFields.has(field) || taskAssigneeEditFields.has(field) || taskClassificationFields.includes(field) ||
      (Object.hasOwn(patch, 'keep_as_collaborator') && taskHandoverFields.includes(field)));
}

function changeAttachment(db, user, task, patch) {
  if (!Object.hasOwn(patch, 'attachment_path') && !Object.hasOwn(patch, 'attachment_name')) return [];
  const nextId = patch.attachment_path ?? null;
  const oldId = task.attachment_path;
  if (nextId) {
    const file = db.attachments.find(row => row.id === nextId);
    const pendingOwnFile = file && file.task_id === null && file.uploaded_by === user.id && file.created_at > Date.now() - expiry;
    if (!file || (file.task_id !== task.id && !pendingOwnFile)) {
      throw new RequestError(400, '附件不可用，请重新选择并上传文件。');
    }
    if (!patch.attachment_name) throw new RequestError(400, '缺少附件名称。');
    file.task_id = task.id;
  }
  task.attachment_path = nextId;
  task.attachment_name = nextId ? patch.attachment_name : null;
  if (!oldId || oldId === nextId) return [];
  db.attachments = db.attachments.filter(file => file.id !== oldId);
  return [oldId];
}

function removeFile(directory, id) {
  if (!/^[a-f0-9-]{36}$/.test(id)) return;
  try { unlinkSync(join(directory, id)); }
  catch (error) {
    if (error.code !== 'ENOENT') console.error('清理附件失败：', error.code);
  }
}

function publicRecord(db, user, table, row) {
  if (table === 'tasks') return publicTask(db, row);
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
  if (table === 'tasks') {
    Object.assign(row, { owner_name: null, assignee_id: null, status: statuses[0], pri: defaultPriority, collaborators: [] });
  }
  const result = applyPatch(db, user, table, row, patch, recordTaskChange, true);
  db[table].unshift(row);
  return result;
}

export function insertHistoricalTask(db, admin, member, fields) {
  const { row } = insertRecord(db, admin, 'tasks', cleanFields('tasks', fields));
  // Match the existing account even when the member has since left the team.
  row.assignee_id = member.id;
  row.owner_name = member.name;
  delete row.pri;
  return row;
}

export function openRecords(store, { recordTaskChange } = {}) {
  const needsReceiver = task => task.demand_id != null && !Object.hasOwn(task, 'initial_receiver_id');
  if (store.read().tasks.some(needsReceiver)) {
    store.update(db => {
      for (const task of db.tasks.filter(needsReceiver)) {
        task.initial_receiver_id = task.assignee_id ?? null;
        task.initial_receiver_name = taskOwnerName(db, task) ?? null;
      }
    });
  }

  function cleanupUploads() {
    const expired = store.read().attachments.filter(row => row.task_id === null && row.created_at <= Date.now() - expiry);
    if (!expired.length) return;
    const ids = new Set(expired.map(row => row.id));
    store.update(db => { db.attachments = db.attachments.filter(row => !ids.has(row.id)); });
    ids.forEach(id => removeFile(store.attachments, id));
  }

  cleanupUploads();
  const cleanup = setInterval(() => {
    try { cleanupUploads(); }
    catch (error) { console.error('未完成的附件清理未成功：', error.code || error.message); }
  }, 60 * 60 * 1000);
  cleanup.unref();

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
          return {
            data: db.tasks.filter(task => visibleTask(user, task))
              .map(task => publicTask(db, task, demands.get(task.demand_id) ?? null)),
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
      const { row, removed } = store.update(db => {
        const list = db[table];
        if (id !== null) {
          const index = list.findIndex(item => item.id === id);
          if (index === -1) throw new RequestError(404, '未找到此记录。');
          if (!changeable(db, user, table, list[index], op, patch)) throw new RequestError(403, '你没有权限修改或删除这条记录。');
          if (op === 'delete') {
            if (table === 'demands') {
              const linked = db.tasks.filter(task => task.demand_id === id);
              if (linked.length && !isAdmin(user)) throw new RequestError(403, '已派发的需求只能由管理员删除。');
              for (const task of linked) Object.assign(task, demandTaskFields(list[index]), { demand_id: null });
            }
            const [row] = list.splice(index, 1);
            const removed = table === 'tasks' ? db.attachments.filter(file => file.task_id === row.id).map(file => file.id) : [];
            if (removed.length) db.attachments = db.attachments.filter(file => file.task_id !== row.id);
            return { row, removed };
          }
          if (table === 'tasks') prepareTaskPeopleUpdate(user, list[index], patch);
          return applyPatch(db, user, table, list[index], patch, recordTaskChange);
        }
        return insertRecord(db, user, table, patch, recordTaskChange);
      });
      removed.forEach(id => removeFile(store.attachments, id));
      return { data: [publicRecord(store.read(), user, table, row)] };
    },

    dispatchDemand(user, { demandId, dispatchKey, task }) {
      const id = recordId(demandId);
      if (typeof dispatchKey !== 'string' || !/^[a-f0-9-]{36}$/.test(dispatchKey)) throw new RequestError(400, '派发编号无效。');
      const patch = cleanFields('tasks', task);
      if (!patch.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');
      for (const field of ['due', 'planned_hours', 'project_stage']) delete patch[field];

      const { created, demand } = store.update(db => {
        const source = db.demands.find(row => row.id === id);
        if (!source) throw new RequestError(404, '未找到此需求。');
        if (!managesRecord(user, source)) throw new RequestError(403, '只有管理员或需求创建人可以派发任务。');
        const existing = db.tasks.find(row => row.demand_id === id);
        if (existing) {
          if (existing.creator_id === user.id && existing.dispatch_key === dispatchKey) return { created: existing, demand: source };
          throw new RequestError(409, '这条需求已经派发，可在需求列表增加合作者。');
        }
        const details = { desc: source.descr ?? null, ...patch, ...demandTaskFields(source) };
        const row = insertRecord(db, user, 'tasks', details, recordTaskChange, { demand_id: id, dispatch_key: dispatchKey }).row;
        row.initial_receiver_id = row.assignee_id;
        row.initial_receiver_name = row.owner_name;
        return { created: row, demand: source };
      });
      const db = store.read();
      return { task: publicTask(db, created, demand), demand: publicRecord(db, user, 'demands', demand) };
    },

    changeDemandTaskPeople(user, input) {
      const id = recordId(input.demandId);
      const taskId = recordId(input.taskId);
      const reassign = Object.hasOwn(input, 'assignee_id');
      const add = Object.hasOwn(input, 'collaborator_ids');
      if (reassign === add) throw new RequestError(400, '请选择更换负责人或增加合作者。');
      if (reassign && !isAdmin(user)) throw new RequestError(403, '只有管理员可以更换派发任务的负责人。');
      const patch = cleanFields('tasks', reassign ? { assignee_id: input.assignee_id } : { collaborator_ids: input.collaborator_ids });
      if ((reassign && patch.assignee_id == null) || (add && !patch.collaborator_ids.length)) {
        throw new RequestError(400, reassign ? '请选择负责人。' : '请至少选择一位合作者。');
      }
      const demand = store.update(db => {
        const source = db.demands.find(row => row.id === id);
        if (!source) throw new RequestError(404, '未找到此需求。');
        if (!managesRecord(user, source)) throw new RequestError(403, '只有管理员或需求创建人可以增加合作者。');
        const task = db.tasks.find(row => row.id === taskId && row.demand_id === id);
        if (!task) throw new RequestError(409, '关联任务已变化，请刷新后重试。');
        if (add) {
          const existing = (task.collaborators || []).map(person => person.id);
          patch.collaborator_ids = [...new Set([...existing, ...patch.collaborator_ids])].filter(personId => personId !== task.assignee_id);
        }
        applyPatch(db, user, 'tasks', task, patch, recordTaskChange);
        return source;
      });
      return { demand: publicRecord(store.read(), user, 'demands', demand) };
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

    upload(user, body) {
      if (!body.length) throw new RequestError(400, '请选择非空文件。');
      const pending = store.read().attachments.filter(file => file.uploaded_by === user.id && file.task_id === null);
      if (pending.length >= 12) throw new RequestError(429, '待绑定的附件过多，请先保存已上传的任务。');
      const id = randomUUID();
      writeFileSync(join(store.attachments, id), body, { flag: 'wx', mode: 0o600 });
      try {
        store.update(db => {
          db.attachments.push({ id, task_id: null, uploaded_by: user.id, created_at: Date.now() });
        });
      } catch (error) {
        removeFile(store.attachments, id);
        throw error;
      }
      return { path: id };
    },

    openAttachment(user, value) {
      const id = recordId(value);
      const db = store.read();
      const task = db.tasks.find(row => row.id === id && visibleTask(user, row));
      const file = task && db.attachments.find(row => row.task_id === id && row.id === task.attachment_path);
      if (!file) throw new RequestError(404, '这条任务没有可下载的附件。');
      const path = join(store.attachments, file.id);
      let fd;
      try {
        fd = openSync(path, 'r');
        return { fd, name: task.attachment_name || '附件', size: fstatSync(fd).size };
      } catch (error) {
        if (fd !== undefined) closeSync(fd);
        if (error.code !== 'ENOENT') throw error;
        throw new RequestError(404, '服务器上找不到这份附件。');
      }
    }
  };
}

function applyPatch(db, user, table, row, patch, recordTaskChange, creating = false) {
  const before = table === 'tasks' && recordTaskChange ? {
    creating, owner: row.assignee_id, collaborators: new Set(row.collaborators?.map(person => person.id))
  } : null;
  let removed = [];
  if (table === 'tasks') {
    if (creating && (Object.hasOwn(patch, 'keep_as_collaborator') || Object.hasOwn(patch, 'add_collaborator_ids'))) {
      throw new RequestError(400, '请在任务创建后转交或添加合作者。');
    }
    applyTaskPeople(db, row, patch);
    removed = changeAttachment(db, user, row, patch);
    delete patch.attachment_path;
    delete patch.attachment_name;
    if (!creating && row.demand_id != null) {
      delete patch.title;
      delete patch.proj;
    }
  }
  if (table === 'demands' && patch.proposer != null && patch.proposer !== row.proposer &&
      !db.demandOptions.proposer.includes(patch.proposer)) {
    throw new RequestError(409, '需求提出方已不可选，请重新选择。');
  }
  Object.assign(row, patch, { updated_at: now() });
  if (table === 'profiles') {
    if (!row.display_name) throw new RequestError(400, '请填写姓名。');
    row.owner_name = row.display_name;
  } else if (!row.title) {
    throw new RequestError(400, '请填写名称。');
  }
  if (table === 'tasks' && !statuses.includes(row.status)) throw new RequestError(400, '任务状态无效。');
  if (before) recordTaskChange(db, row, before);
  return { row, removed };
}

import { randomUUID } from 'node:crypto';
import { openSync, closeSync, fstatSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isAdmin, now, optionalText } from './accounts.mjs';
import { RequestError } from './store.mjs';

const fields = {
  profiles: { display_name: 100, emp_no: 100, role: 100, team: 100, status: 20, contact: 200, duty: 10000, remark: 10000 },
  tasks: {
    title: 180, proj: 100, owner_name: 100, assignee_id: 0, collaborator_ids: 0, status: 20, pri: 20, due: 10, start: 10, end: 10,
    start_time: 10, end_time: 10, hours: 0, result: 10000, desc: 10000, attachment_name: 255, attachment_path: 60
  },
  demands: { title: 180, proj: 100, descr: 10000, proposer: 100 }
};
const sequence = { profiles: 'profile', tasks: 'task', demands: 'demand' };
const statuses = ['待规划', '开发中', '测试中', '已完成'];
const demandOptionLabels = { proj: '项目', proposer: '需求提出方' };
const taskProgressFields = new Set(['status', 'start', 'end', 'start_time', 'end_time', 'hours', 'result', 'attachment_name', 'attachment_path']);
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
    if (key === 'hours') {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new RequestError(400, '投入工时须为非负数。');
      }
      patch[key] = value;
    } else if (key === 'assignee_id') {
      if (value !== null && !validId(value)) throw new RequestError(400, '负责人编号无效。');
      patch[key] = value;
    } else if (key === 'collaborator_ids') {
      if (!Array.isArray(value) || !value.every(validId)) throw new RequestError(400, '合作者名单无效。');
      patch[key] = [...new Set(value)];
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

function publicTask(db, task) {
  const assignee = db.users.find(user => user.id === task.assignee_id);
  const { dispatch_key, ...row } = task;
  return { ...row, owner_name: assignee ? displayName(db, assignee) : task.owner_name,
    collaborators: (task.collaborators || []).map(person => {
      const user = db.users.find(item => item.id === person.id);
      return user ? { id: person.id, name: displayName(db, user) } : person;
    }) };
}

function publicDemand(db, user, row, linkedTasks) {
  const assigned = db.profiles.find(profile => profile.owner_id === row.responsible_id);
  return { ...row, responsible: assigned?.display_name || row.responsible || null, linked_tasks: linkedTasks.map(task => {
    const assignee = db.users.find(person => person.id === task.assignee_id);
    const summary = { owner_name: assignee ? displayName(db, assignee) : task.owner_name, status: task.status };
    return visibleTask(user, task) ? { ...summary, id: task.id, title: task.title } : summary;
  }) };
}

function applyDemandChoices(db, row, patch) {
  for (const [key, label] of Object.entries(demandOptionLabels)) {
    if (patch[key] != null && patch[key] !== row[key] && !db.demandOptions[key].includes(patch[key])) {
      throw new RequestError(409, label + '已不可选，请重新选择。');
    }
  }
}

function taskMember(db, id, label) {
  const profile = db.profiles.find(person => person.owner_id === id && person.status !== '已离职');
  if (!profile?.display_name || !db.users.some(user => user.id === id)) {
    throw new RequestError(409, label + '已不可选，请重新选择。');
  }
  return { id, name: profile.display_name };
}

function applyTaskPeople(db, task, patch) {
  if (Object.hasOwn(patch, 'assignee_id')) {
    if (patch.assignee_id !== task.assignee_id) {
      const owner = patch.assignee_id === null ? null : taskMember(db, patch.assignee_id, '负责人');
      task.assignee_id = owner?.id ?? null;
      task.owner_name = owner?.name ?? null;
    }
  } else if (Object.hasOwn(patch, 'owner_name')) {
    // Older task clients may still submit the original name or account field.
    const current = db.users.find(user => user.id === task.assignee_id);
    if (task.assignee_id == null || (current ? displayName(db, current) : task.owner_name) !== patch.owner_name) {
      assignTask(db, task, patch.owner_name);
    }
  }
  if (task.demand_id != null && !task.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');
  if (Object.hasOwn(patch, 'collaborator_ids')) {
    const existing = new Map((task.collaborators || []).map(person => [person.id, person]));
    task.collaborators = patch.collaborator_ids.map(id => existing.get(id) || taskMember(db, id, '合作者'));
  }
  if (task.collaborators?.some(person => person.id === task.assignee_id)) {
    throw new RequestError(400, '负责人不能同时列为合作者。');
  }
  delete patch.owner_name;
  delete patch.assignee_id;
  delete patch.collaborator_ids;
}

function managesRecord(user, row) {
  return isAdmin(user) || (row.creator_id ?? row.owner_id) === user.id;
}

function visibleTask(user, task) {
  return managesRecord(user, task) || task.assignee_id === user.id || task.collaborators?.some(person => person.id === user.id);
}

function changeable(user, table, row, op, patch) {
  if (table === 'profiles') {
    return op === 'delete' ? isAdmin(user) && row.owner_id !== user.id : isAdmin(user) || row.owner_id === user.id;
  }
  if (managesRecord(user, row)) return true;
  if (table === 'demands' && op === 'update') return true;
  return table === 'tasks' && op === 'update' && row.assignee_id === user.id &&
    Object.keys(patch).every(field => taskProgressFields.has(field));
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

function insertRecord(db, user, table, patch, extra = {}) {
  if (table === 'profiles' && db.profiles.some(row => row.owner_id === user.id)) {
    throw new RequestError(409, '你的个人档案已经存在。');
  }
  const row = { id: db.seq[sequence[table]]++, owner_id: user.id, owner_name: displayName(db, user), created_at: now(), ...extra };
  if (table !== 'profiles') row.creator_id = user.id;
  if (table === 'tasks') Object.assign(row, { owner_name: null, assignee_id: null, status: statuses[0], collaborators: [] });
  const result = applyPatch(db, user, table, row, patch);
  db[table].unshift(row);
  return result;
}

export function openRecords(store) {
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
        if (table === 'profiles' && !isAdmin(user)) return { data: db.profiles.filter(row => row.owner_id === user.id) };
        if (table === 'tasks') return { data: db.tasks.filter(task => visibleTask(user, task)).map(task => publicTask(db, task)) };
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
          if (!changeable(user, table, list[index], op, patch)) throw new RequestError(403, '你没有权限修改或删除这条记录。');
          if (op === 'delete') {
            if (table === 'demands' && db.tasks.some(task => task.demand_id === id)) {
              throw new RequestError(409, '这条需求还有关联任务，请先处理关联任务。');
            }
            const [row] = list.splice(index, 1);
            const removed = table === 'tasks' ? db.attachments.filter(file => file.task_id === row.id).map(file => file.id) : [];
            if (removed.length) db.attachments = db.attachments.filter(file => file.task_id !== row.id);
            return { row, removed };
          }
          return applyPatch(db, user, table, list[index], patch);
        }
        return insertRecord(db, user, table, patch);
      });
      removed.forEach(id => removeFile(store.attachments, id));
      return { data: [publicRecord(store.read(), user, table, row)] };
    },

    dispatchDemand(user, { demandId, dispatchKey, task }) {
      const id = recordId(demandId);
      if (typeof dispatchKey !== 'string' || !/^[a-f0-9-]{36}$/.test(dispatchKey)) throw new RequestError(400, '派发编号无效。');
      const patch = cleanFields('tasks', task);
      if (!patch.assignee_id) throw new RequestError(400, '派发任务需要选择负责人。');

      const { created, demand } = store.update(db => {
        const source = db.demands.find(row => row.id === id);
        if (!source) throw new RequestError(404, '未找到此需求。');
        if (!managesRecord(user, source)) throw new RequestError(403, '只有管理员或需求创建人可以派发任务。');
        const existing = db.tasks.find(row => row.demand_id === id && row.creator_id === user.id && row.dispatch_key === dispatchKey);
        const details = { title: source.title, proj: source.proj ?? null, desc: source.descr ?? null, ...patch };
        const row = existing || insertRecord(db, user, 'tasks', details, { demand_id: id, dispatch_key: dispatchKey }).row;
        return { created: row, demand: source };
      });
      const db = store.read();
      return { task: publicTask(db, created), demand: publicRecord(db, user, 'demands', demand) };
    },

    demandChoices() {
      const db = store.read();
      const users = new Map(db.users.map(user => [user.id, user.account]));
      const people = db.profiles.filter(profile => profile.status !== '已离职' && profile.display_name && users.has(profile.owner_id))
        .map(profile => ({ id: profile.owner_id, name: profile.display_name, emp_no: profile.emp_no || users.get(profile.owner_id) }));
      return { options: db.demandOptions, people };
    },

    changeDemandOptions({ kind, action, name }) {
      if (typeof kind !== 'string' || !Object.hasOwn(demandOptionLabels, kind) || !['add', 'remove'].includes(action)) {
        throw new RequestError(400, '需求选项操作无效。');
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

function applyPatch(db, user, table, row, patch) {
  let removed = [];
  if (table === 'tasks') {
    applyTaskPeople(db, row, patch);
    removed = changeAttachment(db, user, row, patch);
    delete patch.attachment_path;
    delete patch.attachment_name;
  }
  if (table === 'demands') applyDemandChoices(db, row, patch);
  Object.assign(row, patch, { updated_at: now() });
  if (table === 'profiles') {
    if (!row.display_name) throw new RequestError(400, '请填写姓名。');
    row.owner_name = row.display_name;
  } else if (!row.title) {
    throw new RequestError(400, '请填写名称。');
  }
  if (table === 'tasks' && !statuses.includes(row.status)) throw new RequestError(400, '任务状态无效。');
  return { row, removed };
}

import { exportWeek } from './export.mjs';
import { ACTIVE_TASK_STATUSES, formatPlanningTime, plannedCompletion, TASK_PRIORITIES as PRIORITY } from './task-planning.mjs';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const taskHandoverDialog = $('#task-handover-dialog');
const taskStartDialog = $('#task-start-dialog');
const guidelinesDialog = $('#guidelines-dialog');
const guidelinesBody = $('#guidelines-dialog-body');
const guidelinesConfirm = $('#confirm-guidelines');
const guidelinesScrollHint = $('#guidelines-scroll-hint');
const STATUS = ['待规划', ...ACTIVE_TASK_STATUSES, '已完成'];
const MEMBER_STATUS = ['在职', '开发中', '会议中', '请假', '出差', '调岗', '已离职'];
const dispatchTimeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const PAGE_TITLES = { home: '工作台', tasks: '任务中心', taskLink: '任务详情', demands: '需求管理', demandCatalog: '基础配置', people: '人员管理', board: '数据看板', account: '我的账号', guidelines: '行为规范' };
const dictionaries = { teams: '团队', roles: '岗位' };
const catalogLabels = { proj: '项目', proposer: '需求提出方', category: '工单分类', device_type: '设备类型', project_stage: '项目阶段' };
const otherTaskCategory = '其他';
const colors = ['#8c9eb9', '#5879e4', '#cc912d', '#26a980'];
const defaultFilters = {
  taskQuery: '', taskCategory: '', taskStatus: '', taskPriority: '', taskScope: 'mine',
  demandQuery: '', peopleQuery: '', peopleTeam: ''
};
const listPageSize = 10;
const firstListPages = { tasks: 1, demands: 1 };
const state = {
  user: null, tasks: [], demands: [], profiles: [], accounts: [], page: 'home', mode: 'login',
  registrationEnabled: false,
  filters: { ...defaultFilters },
  listPages: { ...firstListPages },
  taskSort: null,
  catalog: { teams: [], roles: [] },
  taskCategories: new Set(),
  demandCatalog: null, demandCatalogError: '', demandCatalogKind: 'proj',
  guidelines: undefined, guidelinesError: '', guidelinesPending: false,
  loadWarnings: []
};
let toastTimer;
let demandCatalogLoad;
let guidelinesLoad;
let guidelinesReachedEnd = false;
let refreshVersion = 0;
let authOptionsVersion = 0;

function text(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const shown = value => text(value == null || value === '' ? '—' : value);
const admin = () => state.user?.role === '管理员';
const primaryAdmin = () => state.user?.is_primary_admin === true;
const accountRole = account => account.is_primary_admin ? '超级管理员' : account.role;
const same = (a, b) => a != null && b != null && String(a) === String(b);
const mineProfile = () => state.profiles.find(person => same(person.owner_id, state.user?.id));
const myName = () => mineProfile()?.display_name || state.user?.name || '';
const sortZh = (a, b) => a.localeCompare(b, 'zh-CN');
const unique = values => [...new Set(values.filter(Boolean))].sort(sortZh);
const trimmed = value => String(value ?? '').trim();
const optional = value => trimmed(value) || null;
const taskPriority = priority => PRIORITY.includes(priority) ? priority : '中';
const sumHours = rows => Math.round(rows.reduce((sum, row) => sum + (Number(row.hours) || 0), 0) * 100) / 100;
const withHours = value => value == null || value === '' ? '—' : value + 'h';
const hasText = (query, ...fields) => fields.join(' ').toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
const personFor = account => state.profiles.find(person => same(person.owner_id, account.id));

function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5500);
}

async function request(url, options = {}) {
  const session = state.user;
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.file || (options.body ? JSON.stringify(options.body) : undefined)
  }).catch(() => { throw new Error('无法连接工作台服务，请稍后再试。'); });
  const type = response.headers.get('Content-Type') || '';
  const data = type.includes('application/json') ? await response.json().catch(() => null) : null;
  if (session !== state.user) throw new Error('登录状态已改变，请重试。');
  if (response.status === 401 && state.user && !options.silentSession) {
    showAuth();
    toast('登录已失效，请重新登录。');
  }
  if (!response.ok || data?.error || data?.ok === false) {
    if (options.silentSession && response.status === 401) return null;
    const error = new Error(data?.message || data?.error || '操作失败，请稍后再试。');
    error.status = response.status;
    throw error;
  }
  return options.download ? response.blob() : data;
}
const post = (url, body = {}) => request(url, { method: 'POST', body });
function db(table, op, payload, id) {
  return post('/api/db', { table, op, payload, eq: id == null ? undefined : ['id', id] });
}
function saveRow(table, row, id) {
  return db(table, id == null ? 'insert' : 'update', row, id).then(result => {
    if (!result?.data?.length) throw new Error('服务器没有保存这条记录，请刷新后重试。');
    return result.data[0];
  });
}

function isoDate(date = new Date()) {
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-');
}
function dateValue(date, createdAt) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(date || '')) return date;
  if (!/^\d{2}-\d{2}$/.test(date || '')) return '';
  const reference = createdAt ? new Date(createdAt) : new Date();
  if (Number.isNaN(reference.getTime())) return '';
  const year = reference.getFullYear();
  const [month, day] = date.split('-').map(Number);
  const candidates = [year - 1, year, year + 1].map(value => new Date(value, month - 1, day))
    .filter(value => value.getMonth() === month - 1 && value.getDate() === day)
    .sort((a, b) => Math.abs(a - reference) - Math.abs(b - reference));
  return candidates.length ? isoDate(candidates[0]) : '';
}
function normalizeTask(row) {
  const originalLocalFile = row.attachPath && /^(?:[a-z]:[\\/]|[\\/])/i.test(row.attachPath);
  const startTime = formatPlanningTime(row.started_at) || sharedDate(row.start_time, row.start, row.created_at);
  const dueTime = formatPlanningTime(row.planned_due_at) || dateValue(row.due, row.created_at);
  return {
    ...row,
    startTime, dueTime,
    startDate: startTime.slice(0, 10),
    endDate: sharedDate(row.end_time, row.end, row.created_at),
    dueDate: dueTime.slice(0, 10),
    sharedFile: !originalLocalFile && !!row.attachment_path,
    fileName: originalLocalFile ? row.attach : row.attachment_name || row.attach || ''
  };
}
function sharedDate(iso, legacy, createdAt) {
  if (legacy !== undefined && legacy !== iso?.slice(5)) return dateValue(legacy, iso || createdAt);
  return dateValue(iso || legacy, createdAt);
}
function weekRange() {
  const from = new Date();
  from.setDate(from.getDate() - (from.getDay() + 6) % 7);
  const to = new Date(from);
  to.setDate(to.getDate() + 6);
  return [isoDate(from), isoDate(to)];
}
function inWeek(value, [from, to]) { return value >= from && value <= to; }
function overdue(task) {
  if (task.status === '已完成' || !task.dueTime) return false;
  const deadline = Date.parse(task.planned_due_at);
  return Number.isFinite(deadline) ? Date.now() > deadline : task.dueDate < isoDate();
}
function assignedToMe(task) { return same(task.assignee_id, state.user.id); }
function collaboratingOn(task) { return (task.collaborators || []).some(person => same(person.id, state.user.id)); }
function ownTask(task) {
  return assignedToMe(task) || collaboratingOn(task);
}
function canEditTask(task) { return admin() || same(task.creator_id ?? task.owner_id, state.user.id); }
function canUpdateTaskProgress(task) { return canEditTask(task) || same(task.assignee_id, state.user.id); }
function canEditProfile(person) {
  return same(person.owner_id, state.user.id) ||
    (admin() && !state.accounts.some(account => account.is_primary_admin && same(account.id, person.owner_id)));
}
function canManageDemand(demand) { return admin() || same(demand.creator_id ?? demand.owner_id, state.user.id); }
function canEditTaskClassification(task) {
  const source = task.demand_id == null ? null : state.demands.find(demand => same(demand.id, task.demand_id));
  return source ? canManageDemand(source) : canEditTask(task);
}
function canDeleteDemand(demand) { return admin() || (canManageDemand(demand) && !demand.linked_tasks?.length); }
const collaboratorNames = task => (task.collaborators || []).map(person => person.name).join('、');

function loadCatalog() {
  try {
    const saved = JSON.parse(localStorage.getItem('yxt-web-catalog-' + state.user.id) || '{}');
    return { teams: Array.isArray(saved?.teams) ? saved.teams : [], roles: Array.isArray(saved?.roles) ? saved.roles : [] };
  } catch { return { teams: [], roles: [] }; }
}
function storeCatalog() { localStorage.setItem('yxt-web-catalog-' + state.user.id, JSON.stringify(state.catalog)); }

function showAuth(error = '') {
  const entering = $('#auth-view').hidden;
  state.user = null;
  state.tasks = [];
  state.demands = [];
  state.profiles = [];
  state.accounts = [];
  state.taskCategories.clear();
  state.demandCatalog = null;
  state.demandCatalogError = '';
  state.demandCatalogKind = 'proj';
  state.guidelines = undefined;
  state.guidelinesError = '';
  state.guidelinesPending = false;
  guidelinesLoad = undefined;
  state.loadWarnings = [];
  state.page = 'home';
  state.filters = { ...defaultFilters };
  state.listPages = { ...firstListPages };
  state.taskSort = null;
  document.title = '工程小管家';
  if (taskHandoverDialog.open) taskHandoverDialog.close('cancel');
  if (taskStartDialog.open) taskStartDialog.close('cancel');
  dialog.close();
  guidelinesDialog.close();
  content.replaceChildren();
  $('#loading-view').hidden = true;
  $('#workspace').hidden = true;
  $('#auth-view').hidden = false;
  const form = $('#auth-form');
  form.reset();
  setAuthMode('login');
  formError($('#auth-error'), error);
  if (entering) {
    state.registrationEnabled = false;
    $('#auth-tabs').hidden = true;
    void loadAuthOptions();
  }
}
async function loadAuthOptions() {
  const version = ++authOptionsVersion;
  const result = await request('/api/auth-options').catch(() => null);
  if (state.user || version !== authOptionsVersion) return;
  state.registrationEnabled = result?.registrationEnabled === true;
  $('#auth-tabs').hidden = !state.registrationEnabled;
  if (!state.registrationEnabled && state.mode === 'register') {
    const message = $('#auth-error').textContent;
    setAuthMode('login');
    formError($('#auth-error'), message);
  }
}
function setAuthMode(mode) {
  const register = mode === 'register' && state.registrationEnabled;
  state.mode = register ? 'register' : 'login';
  const form = $('#auth-form');
  $('#auth-name').hidden = !register;
  form.elements.name.disabled = !register;
  form.elements.name.required = register;
  form.elements.password.minLength = register ? 6 : 1;
  form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-title').textContent = register ? '注册工作台账号' : '登录工作台';
  $('#auth-submit').textContent = register ? '注册并登录' : '登录';
  document.querySelectorAll('[data-auth]').forEach(button => {
    const active = button.dataset.auth === state.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  formError($('#auth-error'), '');
}
function showWorkspace() {
  $('#loading-view').hidden = true;
  $('#auth-view').hidden = true;
  $('#workspace').hidden = false;
  $('[data-page="demandCatalog"]').hidden = !admin();
  const label = myName() || state.user.account;
  $('#avatar').textContent = label.slice(0, 1);
  $('#user-name').textContent = label;
  $('#user-role').textContent = accountRole(state.user);
  $('#today').dateTime = isoDate();
  $('#today').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date());
}
function linkedTaskId() {
  return new URLSearchParams(location.search).get('task');
}
async function enter(user, guidelinesPending) {
  state.user = user;
  state.filters.taskScope = admin() ? 'all' : 'mine';
  state.guidelinesPending = guidelinesPending === true;
  state.catalog = loadCatalog();
  if (user.must_change_pwd) {
    $('#loading-view').hidden = true;
    $('#auth-view').hidden = true;
    forcePassword();
    return;
  }
  await enterWorkspace();
}
async function enterWorkspace() {
  if (linkedTaskId() !== null) state.page = 'taskLink';
  showWorkspace();
  content.innerHTML = '<p class="empty">正在读取工作数据…</p>';
  if (state.guidelinesPending) openGuidelinesNotice();
  await refresh();
}
async function refresh() {
  const session = state.user;
  const version = ++refreshVersion;
  const previous = { tasks: state.tasks, demands: state.demands };
  const requests = [['tasks', '任务', db('tasks', 'select')], ['demands', '需求', db('demands', 'select')], ['profiles', '人员档案', db('profiles', 'select')]];
  if (admin()) requests.push(['accounts', '账号', request('/api/admin/accounts')]);
  const results = await Promise.allSettled(requests.map(row => row[2]));
  if (session !== state.user || version !== refreshVersion) return;
  state.loadWarnings = [];
  results.forEach((result, index) => {
    const [field, label] = requests[index];
    if (Object.hasOwn(previous, field) && state[field] !== previous[field]) return;
    const rows = result.value?.[field === 'accounts' ? 'accounts' : 'data'];
    if (result.status === 'fulfilled' && Array.isArray(rows)) {
      if (field === 'tasks') {
        state.tasks = rows.map(normalizeTask);
        state.taskCategories = new Set(unique(result.value.taskCategories ?? []).filter(name => name !== otherTaskCategory));
        const selected = state.filters.taskCategory;
        if (selected && selected !== otherTaskCategory && !state.taskCategories.has(selected)) {
          state.filters.taskCategory = '';
          state.listPages.tasks = 1;
        }
      } else {
        state[field] = rows;
      }
    } else {
      state.loadWarnings.push(label);
    }
  });
  showWorkspace();
  render();
}

function action(label, name, id = '', className = 'button') {
  return `<button type="button" class="${className}" data-action="${name}" data-id="${text(id)}">${text(label)}</button>`;
}
function heading(title, description = '', actions = '') {
  return `<header class="page-header"><div><h1>${text(title)}</h1>${description ? '<p>' + text(description) + '</p>' : ''}</div><div class="actions">${actions}</div></header>`;
}
function panel(title, body, accessory = '') {
  return `<section class="panel"><header class="panel-header"><h2>${text(title)}</h2>${accessory}</header>${body}</section>`;
}
function stats(items) {
  return `<div class="stats">${items.map(([label, value, detail]) => `<div class="stat"><div class="stat-label">${text(label)}</div><div class="stat-value">${text(value)}</div>${detail ? '<div class="stat-detail">' + text(detail) + '</div>' : ''}</div>`).join('')}</div>`;
}
function tableHeader(header) {
  if (typeof header === 'string') return `<th scope="col">${text(header)}</th>`;
  const { label, sortKey } = header;
  const direction = state.taskSort?.key === sortKey ? state.taskSort.direction : null;
  return `<th scope="col"${direction ? ' aria-sort="' + direction + '"' : ''}>
    <button type="button" class="task-sort-button" data-task-sort="${sortKey}">${text(label)}<span class="sort-indicator" aria-hidden="true"></span></button></th>`;
}
function table(headers, rows, empty, bodyId = '') {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(tableHeader).join('')}</tr></thead><tbody${bodyId ? ' id="' + bodyId + '"' : ''}>${rows || emptyRow(headers.length, empty)}</tbody></table></div>`;
}
function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty">${text(message)}</td></tr>`; }
function statusBadge(status) {
  const variant = { 开发中: 'start', 测试中: 'test', 已完成: 'done', 在职: 'done', 请假: 'test', 已离职: 'danger' }[status] || '';
  return `<span class="tag ${variant}">${shown(status)}</span>`;
}
function priorityBadge(priority) {
  const label = taskPriority(priority);
  const variant = { 低: 'done', 中: 'start', 高: 'test', 极高: 'danger', 立即: 'danger' }[label];
  return `<span class="tag ${variant}">${text(label)}</span>`;
}
function option(value, selected, label = value) {
  return `<option value="${text(value)}"${value === selected ? ' selected' : ''}>${text(label)}</option>`;
}
function filterSelect(key, label, values, blank) {
  const choices = values.map(value => option(value, state.filters[key])).join('');
  return `<select aria-label="${text(label)}" data-filter="${key}">${option('', state.filters[key], blank)}${choices}</select>`;
}
function search(key, label) {
  return `<input type="search" aria-label="${text(label)}" placeholder="${text(label)}" data-filter="${key}" value="${text(state.filters[key])}">`;
}
function chart(rows, empty, unit = '') {
  if (!rows.length) return `<p class="empty">${text(empty)}</p>`;
  const max = Math.max(1, ...rows.map(([, value]) => value));
  return `<div class="chart-list">${rows.map(([name, value, color, pretty]) => `<div class="chart-row"><span>${text(name)}</span><div class="bar" aria-hidden="true"><i style="width:${Math.max(0, Number(value) / max * 100)}%;${color ? 'background:' + color : ''}"></i></div><span class="chart-value">${text(pretty ?? value + unit)}</span></div>`).join('')}</div>`;
}
function grouped(rows, label, value) {
  const map = new Map();
  for (const row of rows) {
    const key = label(row);
    map.set(key, (map.get(key) || 0) + value(row));
  }
  return [...map].map(([key, total]) => [key, Math.round(total * 100) / 100]).sort((a, b) => b[1] - a[1]);
}
function distribution(rows) {
  return chart(STATUS.map((status, index) => [status, rows.filter(task => task.status === status).length, colors[index]]), '', ' 项');
}

function workspacePage() {
  const tasks = state.tasks.filter(ownTask);
  const active = tasks.filter(task => task.status !== '已完成');
  const weekly = tasks.filter(task => assignedToMe(task) && inWeek(task.endDate, weekRange()));
  const queue = [...active].sort((a, b) => (a.dueTime || '9999').localeCompare(b.dueTime || '9999')).slice(0, 8);
  const rows = queue.map(task => `<tr><td>${action(task.title, 'task-detail', task.id, 'link')}</td><td>${shown(task.proj)}</td><td>${statusBadge(task.status)}</td><td class="${overdue(task) ? 'text-red' : ''}">${shown(task.dueTime)}</td></tr>`).join('');
  return heading('工作台', myName() ? '你好，' + myName() : '', action('导出本周任务', 'export-week') + action('＋ 新建任务', 'task-new', '', 'button primary')) +
    stats([['我的未完成任务', active.length], ['我的逾期任务', active.filter(overdue).length], ['我的本周完成工时', sumHours(weekly) + 'h'], ['我的任务完成率', (tasks.length ? Math.round((tasks.length - active.length) / tasks.length * 100) : 0) + '%']]) +
    `<div class="grid-two">${panel('我的待办', table(['任务', '项目', '状态', '计划完成'], rows, '暂无待办任务'), action('任务中心', 'go', 'tasks', 'link'))}${panel('我的任务状态', distribution(tasks))}</div>`;
}

const taskHeaders = [
  '任务', '项目', '工单分类', '状态', { label: '优先级', sortKey: 'pri' }, '负责人',
  { label: '计划完成时间', sortKey: 'dueTime' }, { label: '开始时间', sortKey: 'startTime' },
  { label: '完成日期', sortKey: 'endDate' }, { label: '工时', sortKey: 'hours' }, '操作'
];
const taskSortDefaults = { pri: 'descending', dueTime: 'ascending', startTime: 'ascending', endDate: 'ascending', hours: 'descending' };
const personalTaskScopes = [['mine', '我的全部任务'], ['assigned', '我是责任人'], ['collaborating', '我是合作者']];

function matchesTaskScope(task, scope) {
  if (scope === 'all' && admin()) return true;
  if (scope === 'assigned') return assignedToMe(task);
  if (scope === 'collaborating') return collaboratingOn(task);
  return ownTask(task);
}

function taskCategoryLabel(task) {
  return state.taskCategories.has(task.category) ? task.category : otherTaskCategory;
}

function filteredTasks() {
  const { taskQuery, taskCategory, taskStatus, taskPriority: priority, taskScope } = state.filters;
  return state.tasks.filter(task => matchesTaskScope(task, taskScope) && (!taskStatus || task.status === taskStatus) &&
    (!taskCategory || taskCategoryLabel(task) === taskCategory) && (!priority || taskPriority(task.pri) === priority) &&
    hasText(taskQuery, task.title, task.id, task.proj, task.category, task.device_type, task.project_stage,
      task.owner_name, task.desc, task.result, collaboratorNames(task)));
}
function taskSortValue(task, key) {
  if (key === 'pri') return PRIORITY.indexOf(taskPriority(task.pri));
  const value = task[key];
  if (key !== 'hours') return value || null;
  if (optional(value) === null) return null;
  const hours = Number(value);
  return Number.isFinite(hours) ? hours : null;
}
function sortedTaskList() {
  const tasks = filteredTasks();
  if (!state.taskSort) return tasks;
  const { key, direction } = state.taskSort;
  const multiplier = direction === 'ascending' ? 1 : -1;
  return tasks.sort((a, b) => {
    const left = taskSortValue(a, key);
    const right = taskSortValue(b, key);
    if (left === null || right === null) return Number(left === null) - Number(right === null);
    return multiplier * (typeof left === 'number' ? left - right : left.localeCompare(right));
  });
}
function fileAction(task) {
  if (!task.fileName) return '—';
  return task.sharedFile
    ? action(task.fileName, 'download', task.id, 'link')
    : `<span title="原附件保存在桌面客户端电脑上">${text(task.fileName)}<small class="muted">桌面本地附件</small></span>`;
}
function taskEditActions(task, className) {
  return canUpdateTaskProgress(task)
    ? action(task.status === '待规划' ? '开始规划' : '更新任务', 'task-update', task.id, className) : '';
}
function taskRows(tasks) {
  return tasks.map(task => {
    const remove = canEditTask(task) ? action('删除', 'task-delete', task.id, 'link danger') : '';
    const ownerBadge = assignedToMe(task) ? '<span class="tag danger task-owner-badge">责任人</span>' : '';
    return `<tr>
    <td>${action(task.title || '未命名任务', 'task-detail', task.id, 'link')}<span class="number">#${text(task.id)}</span>${task.blocked ? '<small class="text-red">阻塞</small>' : ''}</td>
    <td>${shown(task.proj)}</td><td>${text(taskCategoryLabel(task))}</td><td>${statusBadge(task.status)}</td>
    <td>${priorityBadge(task.pri)}</td><td>${shown(task.owner_name)}</td>
    <td class="task-date${overdue(task) ? ' text-red' : ''}">${shown(task.dueTime)}</td>
    <td class="task-date">${shown(task.startTime)}</td><td class="task-date">${shown(task.endDate)}</td><td>${text(withHours(task.hours))}</td>
    <td><div class="row-actions">${taskEditActions(task, 'link') + remove || '—'}${ownerBadge}</div></td></tr>`;
  }).join('');
}
function tasksPage() {
  const scopes = admin() ? [['all', '所有任务'], ...personalTaskScopes] : personalTaskScopes;
  const scope = `<select aria-label="任务范围" data-filter="taskScope">${scopes.map(([value, label]) => option(value, state.filters.taskScope, label)).join('')}</select>`;
  const category = filterSelect('taskCategory', '按工单分类筛选', [...state.taskCategories, otherTaskCategory], '全部分类');
  const priority = filterSelect('taskPriority', '按优先级筛选', PRIORITY, '全部优先级');
  const toolbar = `<div class="toolbar">${search('taskQuery', '搜索任务、编号、项目、分类、设备类型、项目阶段或负责人')}${category}${filterSelect('taskStatus', '按任务状态过滤', STATUS, '全部状态')}${priority}${scope}</div>`;
  return heading('任务中心', '跟进任务分工、进度和交付记录。', action('刷新', 'refresh') + action('导出本周任务', 'export-week') + action('＋ 新建任务', 'task-new', '', 'button primary')) +
    pagedListPanel('tasks', toolbar);
}

const demandHeaders = ['需求编码', '项目', '需求说明', '任务进度', '初始接收人', '当前负责人', '提出方', '创建人', '操作'];
function demandOwner(demand, task) {
  return task?.task_id && admin() ? action(task.owner_name || '设置负责人', 'demand-owner', demand.id, 'link') : shown(task?.owner_name);
}
function demandAssignmentAction(demand, className) {
  if (!canManageDemand(demand)) return '';
  return demand.linked_tasks?.length ? action('增加合作者', 'demand-collaborators', demand.id, className)
    : action('派发任务', 'demand-dispatch', demand.id, className);
}
function filteredDemands() {
  return state.demands.filter(row => hasText(state.filters.demandQuery, row.code, row.title, row.proj, row.descr, row.proposer,
    ...(row.linked_tasks || []).flatMap(task => [task.owner_name, task.initial_receiver_name])));
}
function demandRows(demands) {
  return demands.map(demand => {
    const task = demand.linked_tasks?.[0];
    const edit = canManageDemand(demand) ? action('编辑', 'demand-edit', demand.id, 'link') : '';
    const remove = canDeleteDemand(demand) ? action('删除', 'demand-delete', demand.id, 'link danger') : '';
    return `<tr>
    <td>${action(demand.code, 'demand-detail', demand.id, 'link')}</td><td>${shown(demand.proj)}</td><td>${shown(demand.descr)}</td>
    <td>${task ? statusBadge(task.status) : '<span class="tag">待派发</span>'}</td><td>${shown(task?.initial_receiver_name)}</td>
    <td>${demandOwner(demand, task)}</td><td>${shown(demand.proposer)}</td><td>${shown(demand.owner_name)}</td>
    <td><div class="row-actions">${edit + demandAssignmentAction(demand, 'link') + remove || '—'}</div></td></tr>`;
  }).join('');
}
function demandsPage() {
  const toolbar = `<div class="toolbar">${search('demandQuery', '搜索需求编码、项目或任务负责人')}</div>`;
  return heading('需求管理', '登记需求、派发任务并跟踪进度。', action('刷新', 'refresh') + action('＋ 新建需求', 'demand-new', '', 'button primary')) +
    pagedListPanel('demands', toolbar);
}

const pagedLists = {
  tasks: { id: 'task', title: '任务列表', headers: taskHeaders, items: sortedTaskList, rows: taskRows, empty: '没有匹配的任务。' },
  demands: { id: 'demand', title: '需求列表', headers: demandHeaders, items: filteredDemands, rows: demandRows, empty: '没有匹配的需求。' }
};
function listPage(key) {
  const { items, rows } = pagedLists[key];
  const matches = items();
  const lastPage = Math.max(1, Math.ceil(matches.length / listPageSize));
  const page = Math.min(Math.max(state.listPages[key], 1), lastPage);
  state.listPages[key] = page;
  const start = (page - 1) * listPageSize;
  return {
    countLabel: matches.length + ' 项', pageLabel: `第 ${page} / ${lastPage} 页`,
    previousDisabled: page === 1, nextDisabled: page === lastPage, paginationHidden: lastPage === 1,
    rows: rows(matches.slice(start, start + listPageSize))
  };
}
function pagedListPanel(key, toolbar) {
  const { id, title, headers, empty } = pagedLists[key];
  const page = listPage(key);
  const pagination = `<nav id="${id}-pagination" class="pagination" aria-label="${title}分页"${page.paginationHidden ? ' hidden' : ''}>
    <button type="button" class="button" data-list-step="-1"${page.previousDisabled ? ' disabled' : ''}>上一页</button>
    <span class="muted text-small" data-page-label>${page.pageLabel}</span>
    <button type="button" class="button" data-list-step="1"${page.nextDisabled ? ' disabled' : ''}>下一页</button>
  </nav>`;
  return panel(title, toolbar + table(headers, page.rows, empty, id + '-rows') + pagination,
    `<span id="${id}-count" class="muted text-small">${page.countLabel}</span>`);
}
function updatePagedList(key) {
  const { id, headers, empty } = pagedLists[key];
  const page = listPage(key);
  const pager = $('#' + id + '-pagination');
  $('#' + id + '-rows').innerHTML = page.rows || emptyRow(headers.length, empty);
  $('#' + id + '-count').textContent = page.countLabel;
  pager.hidden = page.paginationHidden;
  pager.querySelector('[data-page-label]').textContent = page.pageLabel;
  pager.querySelector('[data-list-step="-1"]').disabled = page.previousDisabled;
  pager.querySelector('[data-list-step="1"]').disabled = page.nextDisabled;
  return pager;
}

function toggleTaskSort(button) {
  const key = button.dataset.taskSort;
  const firstDirection = taskSortDefaults[key];
  const current = state.taskSort;
  let direction = firstDirection;
  if (current?.key === key) {
    const reverse = firstDirection === 'ascending' ? 'descending' : 'ascending';
    direction = current.direction === firstDirection ? reverse : null;
  }
  state.taskSort = direction ? { key, direction } : null;
  state.listPages.tasks = 1;
  content.querySelector('th[aria-sort]')?.removeAttribute('aria-sort');
  if (direction) button.closest('th').setAttribute('aria-sort', direction);
  updatePagedList('tasks');
}

function demandCatalogPage() {
  const kind = state.demandCatalogKind;
  const label = catalogLabels[kind];
  const tabs = Object.entries(catalogLabels).map(([key, title]) =>
    `<button type="button" class="button" data-action="demand-catalog-tab" data-id="${key}" aria-pressed="${key === kind}">${title}</button>`).join('');
  const header = heading(PAGE_TITLES.demandCatalog, '维护任务与需求表单中的下拉选项。') +
    `<div class="catalog-tabs" role="group" aria-label="配置类别">${tabs}</div>`;
  if (!state.demandCatalog) {
    const error = state.demandCatalogError;
    return header + panel(label, error
      ? `<p class="form-error" role="alert">${text(error)}</p>` + action('重新加载', 'demand-catalog-load', '', 'link')
      : '<p class="empty" role="status">正在加载基础配置…</p>');
  }
  const rows = catalogOptionNames(state.demandCatalog[kind], kind).map(name => `<tr><td>${text(name)}</td><td>${
    action('删除', 'demand-option-remove', JSON.stringify([kind, name]), 'link danger')}</td></tr>`).join('');
  return header + panel(label, table([label, '操作'], rows, '暂无选项。'), action('＋ 新增' + label, 'demand-option-add', kind, 'button primary'));
}

async function loadDemandCatalog() {
  if (!admin()) return;
  const session = state.user;
  state.demandCatalog = null;
  state.demandCatalogError = '';
  if (state.page === 'demandCatalog') render();
  const pending = request('/api/demand-options');
  demandCatalogLoad = pending;
  try {
    const result = await pending;
    if (demandCatalogLoad === pending && session === state.user) state.demandCatalog = result.options;
  } catch (error) {
    if (demandCatalogLoad === pending && session === state.user) state.demandCatalogError = error.message;
  }
  if (demandCatalogLoad === pending && session === state.user && state.page === 'demandCatalog') render();
}

async function changeDemandOption(kind, operation, name) {
  const result = await post('/api/admin/demand-options', { kind, action: operation, name });
  state.demandCatalog = result.options;
  if (state.page === 'demandCatalog') render();
  toast(catalogLabels[kind] + (operation === 'add' ? '已添加。' : '已删除。'));
}

function boardPage() {
  const { tasks } = state;
  const done = tasks.filter(task => task.status === '已完成');
  const due = done.filter(task => task.dueDate && task.endDate);
  const onTime = due.filter(task => task.endDate <= task.dueDate);
  const hours = grouped(tasks, task => task.proj || '未分类', task => Number(task.hours) || 0);
  const active = tasks.filter(task => task.status !== '已完成');
  const load = grouped(active, task => task.owner_name || '未指定', task => Number(task.hours) || 0)
    .map(([name, value]) => [name, Math.round(value / 40 * 100), value > 40 ? '#b02c42' : '#26a980', Math.round(value / 40 * 100) + '% · ' + value + 'h']);
  const completed = done.slice(0, 12).map(task => `<div class="detail-item">${action(task.title, 'task-detail', task.id, 'link')}<span class="number">${shown(task.endDate)}</span><p class="muted text-small">${shown(task.result)}</p></div>`).join('');
  return heading('数据看板', admin() ? '根据团队可见任务实时计算。' : '根据你可见的任务实时计算。') +
    stats([['任务总数', tasks.length], ['完成率', (tasks.length ? Math.round(done.length / tasks.length * 100) : 0) + '%', done.length + ' 项已完成'],
      ['投入工时', sumHours(tasks) + 'h', tasks.filter(task => task.fileName).length + ' 项含附件'], ['按时交付率', due.length ? Math.round(onTime.length / due.length * 100) + '%' : '—', due.length ? onTime.length + ' / ' + due.length + ' 项' : '暂无可统计交付日期']]) +
    `<div class="grid-two">${panel('项目工时分布', chart(hours, '暂无工时记录。', 'h'))}${panel('团队负载', chart(load, '暂无进行中的任务。'), '<span class="muted text-small">进行中工时 ÷ 40h</span>')}
    ${panel('任务状态分布', distribution(tasks))}${panel('近期完成结果', completed ? '<div class="details-list">' + completed + '</div>' : '<p class="empty">暂无已完成的任务。</p>')}</div>`;
}

function catalogOptions(kind) {
  const field = kind === 'teams' ? 'team' : 'role';
  return unique([...state.catalog[kind], ...state.profiles.map(person => person[field])]);
}
const peopleHeaders = ['姓名 / 工号', '团队', '岗位', '状态', '进行中任务', '操作'];
const accountHeaders = ['登录账号', '姓名', '权限', '密码状态', '操作'];
function adminRoleAction(account) {
  if (!primaryAdmin() || !account || account.is_primary_admin) return '';
  return action(account.role === '管理员' ? '取消授权管理员' : '授权管理员', 'account-admin-role', account.id, 'link');
}
function peopleRows() {
  const { peopleQuery, peopleTeam } = state.filters;
  const accounts = new Map(state.accounts.map(account => [account.id, account]));
  return state.profiles.filter(person => (!peopleTeam || person.team === peopleTeam) &&
    hasText(peopleQuery, person.display_name, person.emp_no, person.team, person.role, person.duty)).map(person => {
    const self = same(person.owner_id, state.user.id);
    const editable = canEditProfile(person);
    const active = editable ? state.tasks.filter(task => task.status !== '已完成' &&
      (task.assignee_id == null ? task.owner_name === person.display_name : same(task.assignee_id, person.owner_id))) : null;
    const edit = editable ? action('编辑', 'person-edit', person.id, 'link') : '';
    const management = editable && admin() && !self ? action(person.status === '已离职' ? '恢复在职' : '标记离职', 'person-status', person.id, 'link') +
      action('删档案', 'person-delete', person.id, 'link danger') : '';
    const authorization = adminRoleAction(accounts.get(person.owner_id));
    return `<tr>
      <td>${action(person.display_name || '未填写姓名', 'person-detail', person.id, 'link')}<small class="muted">${shown(person.emp_no)}</small></td>
      <td>${shown(person.team)}</td><td>${shown(person.role)}</td><td>${statusBadge(person.status)}</td>
      <td>${active ? `${active.length} 项 <small class="muted">${sumHours(active)}h</small>` : '—'}</td>
      <td><div class="row-actions">${edit + authorization + management || '—'}</div></td>
    </tr>`;
  }).join('');
}
function accountsRows() {
  return state.accounts.map(account => {
    const person = personFor(account);
    const wecom = !account.is_primary_admin || primaryAdmin()
      ? action(account.wecom_userid ? '编辑企微 ID' : '绑定企微 ID', 'account-wecom', account.id, 'link') : '';
    const manage = account.role !== '管理员'
      ? action('重置账号', 'account-reset', account.id, 'link') + action('删账号', 'account-delete', account.id, 'link danger') : '';
    const authorization = person ? '' : adminRoleAction(account);
    return `<tr><td>${shown(account.account)}</td><td>${shown(person?.display_name || account.name)}</td><td>${shown(accountRole(account))}</td>
      <td>${account.must_change_pwd ? '<span class="tag test">待首次改密</span>' : '已设置'}</td><td><div class="row-actions">${wecom + authorization + manage || '—'}</div></td></tr>`;
  }).join('');
}
function peoplePage() {
  const person = mineProfile();
  const buttons = action(person ? '编辑我的档案' : '建立我的档案', person ? 'person-edit' : 'person-new', person?.id) +
    (admin() ? action('Excel 导入', 'account-import') + action('＋ 添加成员', 'account-add', '', 'button primary') : '');
  const toolbar = `<div class="toolbar">${search('peopleQuery', admin() ? '搜索姓名、工号、团队、岗位或技能' : '搜索姓名、工号、团队或岗位')}${filterSelect('peopleTeam', '按团队过滤', catalogOptions('teams'), '全部团队')}</div>`;
  return heading('人员管理', admin() ? '维护成员档案、在岗状态和登录账号。' : '查阅团队成员信息，维护个人档案。', buttons) +
    panel(admin() ? '成员档案' : '团队通讯录', toolbar + table(peopleHeaders, peopleRows(), '暂无人员档案。', 'people-rows'),
      admin() ? '<div class="actions">' + action('团队选项', 'catalog', 'teams', 'link') + action('岗位选项', 'catalog', 'roles', 'link') + '</div>' : '') +
    (admin() ? panel('登录账号', table(accountHeaders, accountsRows(), '暂无账号。')) : '');
}
function accountPage() {
  const description = primaryAdmin() ? '超级管理员密码由服务器环境文件管理。' : '查看登录信息和修改密码。';
  const actions = primaryAdmin() ? '' : action('修改密码', 'password', '', 'button primary');
  return heading('我的账号', description, actions) +
    panel('账号信息', details([['账号', state.user.account], ['姓名', myName()], ['系统权限', accountRole(state.user)]]));
}

function guidelinesTable({ caption, rows, form }, label) {
  const cells = (row, heading) => row.map((cell, index) => {
    const value = typeof cell === 'string' ? cell : cell.text;
    const span = Number(cell.span) || 1;
    const scope = heading ? 'col' : (form ? index % 2 === 0 : index === 0) ? 'row' : '';
    const tag = scope ? 'th' : 'td';
    return `<${tag}${scope ? ` scope="${scope}"` : ''}${span > 1 ? ` colspan="${span}"` : ''}>${text(value)}</${tag}>`;
  }).join('');
  const header = form ? '' : `<thead><tr>${cells(rows[0], true)}</tr></thead>`;
  const contents = (form ? rows : rows.slice(1)).map(row => `<tr>${cells(row, false)}</tr>`).join('');
  return `<div class="table-wrap guidelines-table" role="region" tabindex="0" aria-label="${text(caption || label)}">
    <table${rows[0].length > 5 ? ' class="guidelines-wide-table"' : ''}>${caption ? `<caption>${text(caption)}</caption>` : ''}${header}<tbody>${contents}</tbody></table>
  </div>`;
}

function guidelinesDocument(document, location) {
  const inNotice = location === 'notice';
  const headingTag = inNotice ? 'h3' : 'h2';
  const sectionId = index => `guidelines-${location}-${index + 1}`;
  const nav = `<nav class="guidelines-toc" aria-label="行为规范目录"><p>目录</p><ul>${document.sections.map((section, index) =>
    `<li>${action(section.title, 'guidelines-jump', sectionId(index), 'guidelines-toc-link')}</li>`).join('')}</ul></nav>`;
  const sections = document.sections.map((section, index) => `<section class="guidelines-section" aria-labelledby="${sectionId(index)}">
    <${headingTag} id="${sectionId(index)}" tabindex="-1">${text(section.title)}</${headingTag}>
    ${(section.articles || []).map(article => `<div class="guidelines-article">
      <p><strong>${text(article.number)}</strong>　${text(article.text)}</p>
      ${article.items?.length ? `<ul class="guidelines-clauses">${article.items.map(item => `<li>${text(item)}</li>`).join('')}</ul>` : ''}
      ${article.table ? guidelinesTable(article.table) : ''}</div>`).join('')}
    ${section.table ? guidelinesTable(section.table, section.title) : ''}
    ${section.note ? `<p class="guidelines-note">${text(section.note)}</p>` : ''}</section>`).join('');
  const highlights = inNotice && document.highlights?.length ? `<section class="guidelines-highlights" aria-label="阅读重点"><h3>阅读重点</h3>
    <ul>${document.highlights.map(highlight => `<li><strong>${text(highlight.title)}</strong><p>${text(highlight.text)}</p>
    <small>${text(highlight.source)}</small></li>`).join('')}</ul></section>` : '';
  return `${highlights}<div class="guidelines-layout">${nav}<div class="guidelines-sections">${sections}</div></div>`;
}

function guidelinesStatus() {
  if (state.guidelinesError) {
    return `<p class="form-error" role="alert">${text(state.guidelinesError)}</p>` + action('重新加载', 'guidelines-load', '', 'link');
  }
  return `<p class="muted" role="status">${state.guidelines === null ? '行为规范尚未发布。' : '正在加载行为规范…'}</p>`;
}

function guidelinesPage() {
  const source = state.guidelines;
  return heading(source?.title || '行为规范') + (source ? guidelinesDocument(source, 'page') : `<div class="panel">${guidelinesStatus()}</div>`);
}

function renderGuidelinesNotice() {
  const source = state.guidelines;
  guidelinesBody.innerHTML = source ? guidelinesDocument(source, 'notice') : guidelinesStatus();
  if (source) $('#guidelines-dialog-title').textContent = source.title;
  guidelinesScrollHint.hidden = !source || guidelinesReachedEnd;
  unlockGuidelinesConfirmation();
}

function unlockGuidelinesConfirmation() {
  if (!guidelinesDialog.open || !state.guidelines || guidelinesReachedEnd) return;
  const remaining = guidelinesBody.scrollHeight - guidelinesBody.clientHeight - guidelinesBody.scrollTop;
  if (remaining > 1) return;
  guidelinesReachedEnd = true;
  guidelinesConfirm.disabled = false;
  guidelinesScrollHint.hidden = true;
}

function loadGuidelines() {
  if (state.guidelines !== undefined || guidelinesLoad) return guidelinesLoad;
  const session = state.user;
  state.guidelinesError = '';
  if (state.page === 'guidelines') render();
  if (guidelinesDialog.open) renderGuidelinesNotice();
  const pending = request('/api/guidelines').then(result => {
    if (session !== state.user) return;
    state.guidelines = result.guidelines;
    if (state.guidelines === null && guidelinesDialog.open) {
      state.guidelinesPending = false;
      guidelinesDialog.close();
    }
  }, error => {
    if (session === state.user) state.guidelinesError = error.message;
  }).finally(() => {
    if (guidelinesLoad !== pending) return;
    guidelinesLoad = undefined;
    if (state.page === 'guidelines') render();
    if (guidelinesDialog.open) renderGuidelinesNotice();
  });
  guidelinesLoad = pending;
  return pending;
}

function openGuidelinesNotice() {
  guidelinesReachedEnd = false;
  guidelinesConfirm.disabled = true;
  formError($('#guidelines-confirm-error'), '');
  guidelinesBody.scrollTop = 0;
  renderGuidelinesNotice();
  if (!guidelinesDialog.open) guidelinesDialog.showModal();
  unlockGuidelinesConfirmation();
  void loadGuidelines();
}

const pages = { home: workspacePage, tasks: tasksPage, taskLink: taskLinkPage, demands: demandsPage, demandCatalog: demandCatalogPage,
  people: peoplePage, board: boardPage, account: accountPage, guidelines: guidelinesPage };
function render() {
  if (!state.user) return;
  document.querySelectorAll('[data-page]').forEach(button => {
    const active = button.dataset.page === (state.page === 'taskLink' ? 'tasks' : state.page);
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.title = PAGE_TITLES[state.page] + ' · 工程小管家';
  const warnings = state.loadWarnings.length
    ? `<div class="panel actions" role="status"><span class="text-red">${text(state.loadWarnings.join('、'))}加载失败。</span>${action('重新加载', 'refresh', '', 'link')}</div>` : '';
  content.innerHTML = warnings + pages[state.page]();
}
function navigate(page) {
  if (!Object.hasOwn(pages, page) || (page === 'demandCatalog' && !admin())) return;
  if (state.page === 'taskLink' && page !== 'taskLink') {
    const url = new URL(location.href);
    url.searchParams.delete('task');
    history.replaceState(null, '', url);
  }
  state.page = page;
  if (page === 'demandCatalog') void loadDemandCatalog();
  else {
    render();
    if (page === 'guidelines') void loadGuidelines();
    if (page === 'tasks' || page === 'demands' || page === 'people') void refresh();
  }
}

function details(entries, className = 'form-grid') {
  return `<dl class="${className}">${entries.map(([label, value, markup]) => `<div><dt>${text(label)}</dt><dd>${markup ? value : shown(value)}</dd></div>`).join('')}</dl>`;
}
function field(label, name, value = '', attributes = '') {
  return `<label>${label}<input name="${name}" value="${text(value)}" ${attributes}></label>`;
}
function area(label, name, value) {
  return `<label>${label}<textarea name="${name}" rows="3" maxlength="10000">${text(value)}</textarea></label>`;
}
function selectField(label, name, values, current, attributes = '') {
  const options = [...new Set([...values, current])].filter(value => value != null);
  return `<label>${label}<select name="${name}" ${attributes}>${options.map(value => option(value, current)).join('')}</select></label>`;
}
function suggestions(label, name, value, values) {
  return field(label, name, value, 'maxlength="100" list="list-' + name + '"') +
    `<datalist id="list-${name}">${values.map(value => '<option value="' + text(value) + '"></option>').join('')}</datalist>`;
}
function formError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}
function modal(title, description, body, locked = false, headingAside = '') {
  const close = locked ? '' : '<button type="button" class="dialog-close" data-action="close" aria-label="关闭">×</button>';
  dialog.dataset.locked = String(locked);
  dialog.innerHTML = `<div class="dialog-heading"><div class="dialog-heading-text"><h2 id="dialog-title">${text(title)}</h2>${description ? '<p class="muted text-small">' + text(description) + '</p>' : ''}</div>
    ${headingAside ? `<div class="dialog-heading-actions">${headingAside}${close}</div>` : close}</div>${body}`;
  if (!dialog.open) dialog.showModal();
}
function modalForm(title, description, fields, onSave, options = {}) {
  const buttons = options.locked ? action('退出登录', 'logout') : action('取消', 'close');
  modal(title, description, `<form id="dialog-form"><div class="stack">${fields}</div><p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions">${buttons}<button type="submit" class="button ${options.danger ? 'danger' : 'primary'}">${text(options.submit || '保存')}</button></div></form>`, options.locked, options.headingAside);
  const form = dialog.querySelector('form');
  const message = form.querySelector('.form-error');
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('[type=submit]');
    if (button.disabled) return;
    button.disabled = true;
    formError(message, '');
    const values = Object.fromEntries(new FormData(form));
    try {
      const result = await onSave(values);
      if (result !== false && dialog.contains(form)) dialog.close();
    } catch (error) {
      formError(message, error.message);
    } finally {
      button.disabled = false;
    }
  });
  return form;
}
function confirmDelete(title, message, perform) {
  modalForm(title, message, '', perform, { danger: true, submit: '确认删除' });
}
function getRow(key, id) {
  const row = state[key].find(record => same(record.id, id));
  if (!row) throw new Error('找不到这条记录，请刷新后重试。');
  return row;
}
function updateRow(key, row) {
  const existing = state[key].findIndex(item => same(item.id, row.id));
  state[key] = existing === -1 ? [row, ...state[key]] : state[key].map((item, index) => index === existing ? row : item);
  render();
}
async function removeRow(tableName, row, success) {
  const result = await db(tableName, 'delete', undefined, row.id);
  if (!result?.data?.length) throw new Error('服务器没有删除这条记录，请刷新后重试。');
  state[tableName] = state[tableName].filter(item => !same(item.id, row.id));
  render();
  toast(success);
}

function taskDispatchTime(task) {
  const dispatchedAt = Date.parse(task.dispatched_at ?? '');
  return Number.isFinite(dispatchedAt) ? dispatchTimeFormat.format(dispatchedAt) : null;
}
function taskDetails(task) {
  const source = state.demands.find(row => same(row.id, task.demand_id));
  const info = details([['项目', task.proj], ['工单分类', task.category],
    ['设备类型', task.device_type], ['项目阶段', task.project_stage],
    ['负责人', task.owner_name], ['合作者', collaboratorNames(task)],
    ...(source ? [['来源需求', action(source.code, 'demand-detail', source.id, 'link'), true]] : []),
    ...(Object.hasOwn(task, 'dispatched_at') ? [['派发时间', taskDispatchTime(task)]] : []),
    ['状态', statusBadge(task.status), true], ['优先级', priorityBadge(task.pri), true],
    ['计划完成时间', task.dueTime], ['计划投入工时', withHours(task.planned_hours)], ['投入工时', withHours(task.hours)],
    ['开始时间', task.startTime], ['完成日期', task.endDate],
    ['附件', fileAction(task), true], ['前置依赖', task.deps]]);
  const remarks = `<div class="details-list"><div class="detail-item"><strong>任务描述</strong><p class="muted">${shown(task.desc)}</p></div>
    <div class="detail-item"><strong>完成结果</strong><p class="muted">${shown(task.result)}</p></div></div>`;
  return info + remarks;
}
function taskDetail(id) {
  const task = getRow('tasks', id);
  modal(task.title || '任务详情', '#' + task.id, taskDetails(task) + `<div class="dialog-actions">
    <a class="button" href="/?task=${text(task.id)}">打开任务页面</a>${action('关闭', 'close')}${taskEditActions(task, 'button primary')}</div>`);
}
function taskLinkPage() {
  const task = state.tasks.find(row => same(row.id, linkedTaskId()));
  const back = action('返回任务中心', 'task-list');
  if (!task) {
    const message = state.loadWarnings.includes('任务') ? '任务加载失败，请重新加载。' : '找不到该任务，或你没有权限查看。';
    return heading('任务详情', '', back) + '<p class="panel">' + message + '</p>';
  }
  return heading(task.title || '任务详情', '#' + task.id, back + taskEditActions(task, 'button primary')) + panel('任务详情', taskDetails(task));
}
function taskAttachmentFields(task) {
  return field('附件（单个文件最多 20MB）', 'file', '', 'type="file"') +
    (task.fileName ? '<p class="muted text-small">当前附件：' + text(task.fileName) + '</p>' : '');
}
async function taskAttachmentPatch(file) {
  if (!file?.name) return {};
  if (!file.size || file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20MB 的非空附件。');
  const uploaded = await request('/api/upload', { method: 'POST', file });
  return { attachment_path: uploaded.path, attachment_name: file.name };
}
async function applySavedTask(row) {
  const saved = normalizeTask(row);
  if (canEditTask(saved) || ownTask(saved)) {
    updateRow('tasks', saved);
  } else {
    state.tasks = state.tasks.filter(task => !same(task.id, saved.id));
    render();
  }
  if (saved.demand_id != null) await refresh();
}
function confirmTaskHandover(form) {
  $('#task-handover-recipient').textContent = '接手人：' + form.querySelector('#choice-assignee_id').value;
  taskHandoverDialog.returnValue = 'cancel';
  return new Promise(resolve => {
    taskHandoverDialog.addEventListener('close', () => {
      const choice = taskHandoverDialog.returnValue;
      resolve(choice === 'keep' ? true : choice === 'leave' ? false : null);
    }, { once: true });
    taskHandoverDialog.showModal();
  });
}
function confirmTaskStart() {
  taskStartDialog.returnValue = 'cancel';
  return new Promise(resolve => {
    taskStartDialog.addEventListener('close', () => resolve(taskStartDialog.returnValue === 'start'), { once: true });
    taskStartDialog.showModal();
  });
}

const planDueHint = '填写计划投入工时后计算';

function taskScheduleFields(task, plan) {
  const start = plan ? formatPlanningTime(plan.startedAt) : task.startTime;
  const entries = [['开始时间', start]];
  if (plan) {
    entries.push(['计划完成时间', `<span data-plan-due aria-live="polite">${planDueHint}</span>`, true]);
  } else {
    entries.push(['计划完成时间', task.dueTime], ['计划投入工时', withHours(task.planned_hours)], ['完成日期', task.endDate]);
  }
  const summary = details(entries, 'form-grid task-form-facts task-schedule-summary');
  return plan ? summary + `<div class="plan-hours-field">
    <label for="plan-hours">计划投入工时（小时）</label>
    <div class="plan-hours-control">
      <input id="plan-hours" name="plan_hours" value="${text(task.planned_hours)}" type="number" min="0.01" step="0.01" required>
      <div class="plan-hours-arrows">
        <button type="button" data-plan-step="1" aria-label="增加 1 小时">▴</button>
        <button type="button" data-plan-step="-1" aria-label="减少 1 小时">▾</button>
      </div>
    </div></div>` : summary;
}

function bindPlanHours(input, preview) {
  function adjust(delta) {
    const current = input.valueAsNumber;
    if (!Number.isFinite(current) && delta < 0) return;
    const hundredths = Number.isFinite(current) ? Math.round(current * 100) : 0;
    input.value = String(Math.max(1, hundredths + delta * 100) / 100);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  input.addEventListener('input', preview);
  input.addEventListener('keydown', event => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
    event.preventDefault();
    adjust(event.key === 'ArrowUp' ? 1 : -1);
  });
  for (const button of input.parentElement.querySelectorAll('[data-plan-step]')) {
    button.addEventListener('click', () => adjust(Number(button.dataset.planStep)));
  }
}

async function openTaskUpdate(id) {
  const task = getRow('tasks', id);
  if (!canUpdateTaskProgress(task)) return;
  if (task.status !== '待规划') return taskForm(task);
  const currentDialog = dialog.firstElementChild;
  try {
    const plan = await post('/api/tasks/plan-preview', { taskId: task.id });
    if (state.user && dialog.firstElementChild === currentDialog) taskForm(normalizeTask(plan.task), undefined, plan);
  } catch (error) {
    if (error.status === 409 && state.user) await refresh();
    throw error;
  }
}

function taskForm(task = {}, demand, plan) {
  const isUpdate = Boolean(task.id);
  if (isUpdate && !canUpdateTaskProgress(task)) return;
  const canEditDetails = !isUpdate || canEditTask(task);
  const currentOwner = isUpdate && assignedToMe(task);
  const canChooseOwner = task.demand_id == null || admin() || currentOwner;
  const canEditClassification = !isUpdate || canEditTaskClassification(task);
  const priority = taskPriority(task.pri);
  const optionKinds = canEditClassification ? ['category', 'device_type'] : [];
  if (!demand) optionKinds.push('project_stage');
  const canEditNameAndProject = canEditDetails && !demand && task.demand_id == null;
  const dispatchKey = demand && crypto.randomUUID();
  const currentAssignee = task.assignee_id ?? (isUpdate ? (task.owner_name ? 'legacy' : null) : demand ? null : state.user.id);
  const initialPeople = task.collaborators || [];
  const existingPeople = new Set(initialPeople.map(person => person.id));
  const ownerField = canChooseOwner ? choiceField(demand ? '负责人（必填）' : '负责人', 'assignee_id')
    : details([['负责人', task.owner_name]], 'task-form-facts');
  const identityFields = canEditNameAndProject
    ? field('任务名称', 'title', task.title, 'required maxlength="180"') +
      `<div class="form-grid">${choiceField('项目', 'proj', { allowCustom: true })}${ownerField}</div>`
    : ownerField;
  const peopleFields = canEditDetails ? collaboratorField()
    : `<p class="muted text-small">当前合作者：${shown(collaboratorNames(task))}</p>` + collaboratorField(false, '添加合作者');
  const priorityField = canEditClassification ? selectField('优先级', 'pri', PRIORITY, priority, plan ? 'form="dialog-form"' : '') : '';
  const headingAside = plan ? `<div class="dialog-priority">${priorityField || `<span>优先级</span>${priorityBadge(priority)}`}</div>` : '';
  const setupFields = identityFields + peopleFields +
    `<div class="form-grid">${plan ? '' : priorityField}${optionKinds.map(taskOptionField).join('')}</div>` +
    (canEditDetails ? area('任务描述', 'desc', task.desc ?? demand?.descr) : '');
  const canChangeStatus = ACTIVE_TASK_STATUSES.includes(task.status);
  const statusField = canChangeStatus ? selectField('状态', 'status', ACTIVE_TASK_STATUSES, task.status)
    : details([['状态', statusBadge(task.status), true]], 'task-form-facts');
  const progressFields = isUpdate && !plan ? `<div class="form-grid">${statusField}
    ${field('投入工时（小时）', 'hours', task.hours, 'type="number" min="0" step="0.01"')}</div>` + area('完成结果', 'result', task.result) : '';
  const scheduleFields = isUpdate ? taskScheduleFields(task, plan) : '';
  const fields = (plan ? scheduleFields + setupFields : setupFields + scheduleFields + progressFields) +
    taskAttachmentFields(task) + choiceStatus;
  const formTitle = demand ? '派发任务' : plan ? '开始规划' : isUpdate ? '更新任务' : '新建任务';
  const context = demand?.code || (isUpdate ? '#' + task.id + ' ' + task.title : '');
  const submit = demand ? '派发任务' : plan ? '开始任务' : '保存';
  let project, owner, collaborators, loadChoices;
  const form = modalForm(formTitle, context, fields, async values => {
    const formUser = state.user;
    const patch = taskOptions.changes();
    if (canEditNameAndProject) {
      const title = trimmed(values.title);
      if (!title) throw new Error('请填写任务名称。');
      if (title !== task.title) patch.title = title;
      const proj = project.value();
      if (proj !== optional(task.proj)) patch.proj = proj;
    }
    if (canEditDetails && optional(values.desc) !== optional(task.desc ?? demand?.descr)) patch.desc = optional(values.desc);
    if (canEditClassification && (!isUpdate || values.pri !== priority)) patch.pri = values.pri;
    if (isUpdate && !plan) {
      if (canChangeStatus && values.status !== task.status) patch.status = values.status;
      const hours = values.hours === '' ? null : Number(values.hours);
      if (hours !== (task.hours ?? null)) patch.hours = hours;
      if (optional(values.result) !== optional(task.result)) patch.result = optional(values.result);
    }
    const plannedHours = plan ? Number(values.plan_hours) : null;
    if (plan && !plannedCompletion(plan.startedAt, plannedHours, patch.pri ?? priority)) {
      throw new Error('请填写有效的计划投入工时，至少为 1 分钟。');
    }
    const assignee = owner?.value() ?? currentAssignee;
    if (!isUpdate && !Number.isSafeInteger(assignee)) throw new Error('请选择负责人。');
    const transferring = currentOwner && assignee !== currentAssignee;
    if (transferring) {
      const keep = await confirmTaskHandover(form);
      if (keep === null) return false;
      patch.keep_as_collaborator = keep;
    }
    if (plan && !(await confirmTaskStart())) return false;
    if (canChooseOwner && (!isUpdate || assignee !== currentAssignee)) patch.assignee_id = assignee;
    const people = collaborators.ids();
    if (canEditDetails) {
      const previousPeople = initialPeople.filter(person => person.id !== assignee);
      if (people.length !== previousPeople.length || previousPeople.some(person => !people.includes(person.id))) patch.collaborator_ids = people;
    } else if (people.length) {
      patch.add_collaborator_ids = people;
    }
    if (!formUser || state.user !== formUser) return false;
    Object.assign(patch, await taskAttachmentPatch(values.file));
    if (!formUser || state.user !== formUser) return false;
    try {
      if (demand) {
        const result = await post('/api/demands/dispatch', { demandId: demand.id, dispatchKey, task: patch });
        updateRow('tasks', normalizeTask(result.task));
        updateRow('demands', result.demand);
      } else if (plan) {
        const result = await post('/api/tasks/start', { taskId: task.id, startToken: plan.startToken, plannedHours, changes: patch });
        await applySavedTask(result.task);
      } else if (!isUpdate || Object.keys(patch).length) {
        await applySavedTask(await saveRow('tasks', patch, task.id));
      }
    } catch (error) {
      if (error.status === 409 && loadChoices) await loadChoices().catch(() => {});
      if ((demand || plan) && error.status === 409 && state.user) await refresh();
      throw error;
    }
    toast(demand ? '任务已派发。' : plan ? '任务已开始。' : transferring ? '任务已转交。' : isUpdate ? '任务已更新。' : '任务已创建。');
  }, { submit, headingAside });
  if (plan) {
    const dueDisplay = form.querySelector('[data-plan-due]');
    const preview = () => {
      const due = plannedCompletion(plan.startedAt, Number(form.elements.plan_hours.value), form.elements.pri?.value ?? priority);
      dueDisplay.textContent = formatPlanningTime(due) || planDueHint;
    };
    bindPlanHours(form.elements.plan_hours, preview);
    form.elements.pri?.addEventListener('input', preview);
    preview();
  }
  const taskOptions = bindTaskOptions(form, task, optionKinds);
  if (canEditNameAndProject) {
    project = bindChoice(form.querySelector('[data-choice=proj]'), { value: optional(task.proj), label: task.proj }, { allowCustom: true });
  }
  collaborators = bindCollaborators(form.querySelector('[data-collaborators]'), canEditDetails ? initialPeople : [], currentAssignee);
  if (canChooseOwner) {
    owner = bindChoice(form.querySelector('[data-choice=assignee_id]'), {
      value: currentAssignee, label: task.owner_name || (!demand && !isUpdate ? myName() : '')
    }, { clearable: false, onChange: collaborators.setOwner });
  }
  loadChoices = prepareFormChoices(form, ({ people, options }) => {
    project?.setOptions(catalogChoiceEntries(options.proj));
    taskOptions.setOptions(options);
    const entries = peopleChoices(people);
    owner?.setOptions(entries.map(({ id, label }) => ({ value: id, label })));
    collaborators.setPeople(canEditDetails ? entries : entries.filter(person => person.id !== currentAssignee && !existingPeople.has(person.id)));
  });
}

function choiceField(label, key, { allowCustom = false } = {}) {
  return `<div class="choice-field" data-choice="${key}">
    <label for="choice-${key}">${label}</label>
    <div class="choice-control">
      <input id="choice-${key}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="choices-${key}"
        autocomplete="off" ${allowCustom ? `maxlength="100" placeholder="请选择或直接输入${label}"` : 'placeholder="请选择或输入关键词"'} disabled>
      <span aria-hidden="true" class="choice-arrow"></span>
      <ul id="choices-${key}" class="choice-list" role="listbox" aria-label="${label}" hidden></ul>
    </div>
  </div>`;
}

function bindChoice(field, initial, { clearable = true, allowCustom = false, onChange } = {}) {
  const input = field.querySelector('input');
  const list = field.querySelector('ul');
  let options = [];
  let selected = initial;
  let query = null;
  let results = [];
  let active = -1;

  function restore() {
    if (selected.value === null) {
      input.value = '';
      return;
    }
    const current = options.find(option => option.value === selected.value);
    const suffix = allowCustom ? '' : selected.value === initial.value ? '（原有值）' : '（不可选）';
    input.value = current?.label ?? (selected.label ? selected.label + suffix : '');
  }
  function highlight(index) {
    list.children[active]?.classList.remove('active');
    active = index;
    const entry = list.children[active];
    if (entry) {
      entry.classList.add('active');
      input.setAttribute('aria-activedescendant', entry.id);
      entry.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  }
  function show() {
    const typed = optional(query);
    results = options.filter(option => hasText(typed ?? '', option.label));
    if (allowCustom && typed && !results.some(option => option.value === typed)) results.push({ value: typed, label: typed, custom: true });
    if (clearable && !typed && selected.value !== null) results.push({ value: null, label: '清空选择' });
    list.innerHTML = results.map(({ value, label, custom }, index) =>
      `<li role="option" id="${list.id}-${index}" data-index="${index}" aria-selected="${value === selected.value}">${text(custom ? '使用「' + label + '」' : label)}</li>`).join('') ||
      `<li role="option" aria-disabled="true" class="muted">${typed ? '没有匹配的选项' : '暂无可选项'}</li>`;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    list.scrollTop = 0;
    highlight(-1);
  }
  function close() {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
    query = null;
    restore();
  }
  function choose(index) {
    selected = results[index];
    close();
    input.select();
    onChange?.(selected.value);
  }

  input.addEventListener('focus', () => { show(); input.select(); });
  input.addEventListener('click', () => {
    if (list.hidden) show();
    if (!query) input.select();
  });
  input.addEventListener('input', () => {
    query = input.value;
    show();
    if (query.trim() && results.length) {
      const exact = allowCustom ? results.findIndex(option => option.value === optional(query)) : -1;
      highlight(Math.max(0, exact));
    }
  });
  input.addEventListener('blur', () => {
    if (allowCustom && query !== null) {
      const value = optional(query);
      selected = { value, label: value };
    }
    close();
  });
  input.addEventListener('keydown', event => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (list.hidden) show();
      if (results.length) {
        const next = event.key === 'ArrowDown' ? active + 1 : (active === -1 ? results.length - 1 : active - 1);
        highlight(Math.max(0, Math.min(results.length - 1, next)));
      }
    } else if (!list.hidden && event.key === 'Enter') {
      event.preventDefault();
      if (active >= 0) choose(active);
    } else if (!list.hidden && event.key === 'Escape') {
      event.preventDefault();
      close();
      input.select();
    }
  });
  list.addEventListener('mousedown', event => event.preventDefault());
  list.addEventListener('click', event => {
    const entry = event.target.closest('[data-index]');
    if (entry) choose(Number(entry.dataset.index));
  });

  return {
    value: () => allowCustom && query !== null ? optional(query) : selected.value,
    setOptions(next) {
      options = next;
      input.disabled = false;
      if (list.hidden) restore();
      else show();
    }
  };
}

function catalogOptionNames(values, kind) {
  const names = [...new Set(values.filter(Boolean))];
  return kind === 'project_stage' ? names : names.sort(sortZh);
}

function catalogChoiceEntries(values, kind) {
  return catalogOptionNames(values, kind).map(value => ({ value, label: value }));
}

function taskOptionField(kind) {
  return choiceField(catalogLabels[kind], kind, { allowCustom: true });
}

function bindTaskOptions(form, task, kinds) {
  const fields = kinds.map(kind => {
    const initial = task[kind] ?? null;
    const picker = bindChoice(form.querySelector(`[data-choice=${kind}]`), { value: initial, label: initial }, { allowCustom: true });
    return { kind, initial, picker };
  });
  return {
    changes() {
      const patch = {};
      for (const { kind, initial, picker } of fields) {
        const value = picker.value();
        if (value !== initial) patch[kind] = value;
      }
      return patch;
    },
    setOptions(options) {
      for (const { kind, picker } of fields) picker.setOptions(catalogChoiceEntries(options[kind], kind));
    }
  };
}

function peopleChoices(people) {
  return people.map(({ id, name, emp_no, is_admin }) => ({ id, name, label: `${name} · ${emp_no}`, searchOnly: is_admin }))
    .sort((a, b) => sortZh(a.label, b.label));
}

function collaboratorField(open = false, label = '合作者') {
  return `<details class="collaborators" data-collaborators${open ? ' open' : ''}><summary>${label} <span data-collaborator-names class="muted">未选择</span></summary>
    <input type="search" placeholder="搜索姓名或工号" aria-label="搜索合作者">
    <div class="collaborator-options" role="group" aria-label="合作者选项"></div></details>`;
}

function bindCollaborators(field, initial, owner) {
  const selected = new Map(initial.map(person => [person.id, person.name]));
  const label = field.querySelector('[data-collaborator-names]');
  const search = field.querySelector('input');
  const list = field.querySelector('.collaborator-options');
  let people = [];

  function filterPeople() {
    const query = search.value.trim();
    const options = list.querySelectorAll('label');
    let matches = 0;
    for (const option of options) {
      option.hidden = query ? !hasText(query, option.textContent)
        : option.hasAttribute('data-search-only') && !option.querySelector('input').checked;
      if (!option.hidden) matches++;
    }
    const empty = list.querySelector('[data-collaborator-empty]');
    empty.hidden = matches > 0;
    empty.textContent = query ? '没有匹配的成员。' : options.length ? '输入姓名或工号搜索成员。' : '没有可选的成员。';
  }
  function showSelected() {
    label.textContent = [...selected].filter(([id]) => id !== owner).map(([, name]) => name).join('、') || '未选择';
  }
  function renderPeople() {
    const available = new Map(people.map(person => [person.id, person]));
    for (const [id, name] of selected) {
      if (!available.has(id)) available.set(id, { label: name + '（不可选）' });
    }
    available.delete(owner);
    list.innerHTML = [...available].map(([id, person]) => `<label class="collaborator-option"${person.searchOnly ? ' data-search-only' : ''}>
      <input type="checkbox" value="${id}" ${selected.has(id) ? 'checked' : ''}>
      <span>${text(person.label)}</span></label>`).join('') + '<p class="muted text-small" data-collaborator-empty></p>';
    filterPeople();
    showSelected();
  }
  search.addEventListener('input', filterPeople);
  search.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.isComposing) event.preventDefault(); });
  list.addEventListener('change', event => {
    const id = Number(event.target.value);
    if (event.target.checked) {
      const person = people.find(item => item.id === id);
      if (person) selected.set(id, person.name);
    } else {
      selected.delete(id);
      if (!people.some(person => person.id === id)) return renderPeople();
    }
    filterPeople();
    showSelected();
  });
  renderPeople();
  return {
    ids: () => [...selected.keys()].filter(id => id !== owner),
    setOwner(id) {
      owner = id;
      renderPeople();
    },
    setPeople(entries) {
      people = entries;
      renderPeople();
    }
  };
}

const choiceStatus = '<p class="muted text-small" data-choice-loading role="status">正在加载可选项…</p>' +
  '<div data-choice-retry hidden><button type="button" class="link">重新加载可选项</button></div>';

function prepareFormChoices(form, applyChoices) {
  const submit = form.querySelector('[type=submit]');
  const loading = form.querySelector('[data-choice-loading]');
  const retry = form.querySelector('[data-choice-retry]');
  const message = form.querySelector('.form-error');
  async function loadChoices() {
    const result = await request('/api/demand-options');
    if (form.isConnected && dialog.open) applyChoices(result);
  }
  async function prepareChoices() {
    submit.disabled = true;
    loading.hidden = false;
    retry.hidden = true;
    formError(message, '');
    try {
      await loadChoices();
      submit.disabled = false;
    } catch (error) {
      formError(message, error.message);
      retry.hidden = false;
    } finally {
      loading.hidden = true;
    }
  }
  retry.querySelector('button').addEventListener('click', prepareChoices);
  void prepareChoices();
  return loadChoices;
}

function demandDetail(id) {
  const demand = getRow('demands', id);
  const tasks = demand.linked_tasks || [];
  const task = tasks[0];
  const items = tasks.map(task => `<div class="detail-item demand-task-item">
    <div>${task.id ? action(task.title || '打开任务', 'demand-task', task.id, 'link') : '<strong>任务</strong>'}
    <p class="muted text-small">${shown(task.owner_name)}</p></div>${statusBadge(task.status)}</div>`).join('');
  modal(demand.code, demand.title, details([['项目', demand.proj], ['需求提出方', demand.proposer], ['创建人', demand.owner_name],
    ['任务进度', task ? statusBadge(task.status) : '<span class="tag">待派发</span>', true],
    ['初始接收人', task?.initial_receiver_name], ['当前负责人', demandOwner(demand, task), true]]) +
    `<div class="details-list"><div class="detail-item"><strong>需求说明</strong><p class="muted">${shown(demand.descr)}</p></div>
      <div class="detail-item"><strong>关联任务</strong>${items || '<p class="muted">待派发</p>'}</div></div>
    <div class="dialog-actions">${action('关闭', 'close')}${demandAssignmentAction(demand, 'button primary')}</div>`);
}

async function saveDemandTaskPeople(demand, task, change) {
  const result = await post('/api/demands/task-people', { demandId: demand.id, taskId: task.task_id, ...change });
  updateRow('demands', result.demand);
  await refresh();
}

function demandOwnerForm(id) {
  if (!admin()) return;
  const demand = getRow('demands', id);
  const task = demand.linked_tasks?.[0];
  if (!task?.task_id) throw new Error('未找到关联任务，请刷新后重试。');
  let owner, loadChoices;
  const form = modalForm('更换负责人', demand.code, choiceField('当前负责人', 'assignee_id') + choiceStatus, async () => {
    const assignee = owner.value();
    if (!Number.isSafeInteger(assignee)) throw new Error('请选择负责人。');
    if (assignee === task.assignee_id) return;
    try {
      await saveDemandTaskPeople(demand, task, { assignee_id: assignee });
    } catch (error) {
      if (error.status === 409) await loadChoices().catch(() => {});
      throw error;
    }
    toast('负责人已更新。');
  });
  owner = bindChoice(form.querySelector('[data-choice=assignee_id]'), { value: task.assignee_id ?? null, label: task.owner_name }, { clearable: false });
  loadChoices = prepareFormChoices(form, ({ people }) => owner.setOptions(peopleChoices(people).map(({ id, label }) => ({ value: id, label }))));
}

function demandCollaboratorsForm(id) {
  const demand = getRow('demands', id);
  if (!canManageDemand(demand)) return;
  const task = demand.linked_tasks?.[0];
  if (!task?.task_id) throw new Error('未找到关联任务，请刷新后重试。');
  let collaborators, loadChoices;
  const form = modalForm('增加合作者', demand.code, collaboratorField(true) + choiceStatus, async () => {
    const people = collaborators.ids();
    if (!people.length) throw new Error('请至少选择一位合作者。');
    try {
      await saveDemandTaskPeople(demand, task, { collaborator_ids: people });
    } catch (error) {
      if (error.status === 409) await loadChoices().catch(() => {});
      throw error;
    }
    toast('合作者已加入任务。');
  }, { submit: '添加' });
  collaborators = bindCollaborators(form.querySelector('[data-collaborators]'), [], task.assignee_id);
  const existing = new Set(task.collaborator_ids || []);
  loadChoices = prepareFormChoices(form, ({ people }) => collaborators.setPeople(peopleChoices(people).filter(person => !existing.has(person.id))));
}

function demandForm(row = {}) {
  if (row.id && !canManageDemand(row)) return;
  const initial = {
    proj: { value: row.proj || null, label: row.proj },
    proposer: { value: row.proposer || null, label: row.proposer }
  };
  const context = row.id ? '需求编码 ' + row.code : '需求编码将在保存后自动生成。';
  const form = modalForm(row.id ? '编辑需求' : '新建需求', context,
    `<div class="form-grid">${choiceField('项目', 'proj', { allowCustom: true })}${choiceField('需求提出方', 'proposer')}</div>` + area('需求说明', 'descr', row.descr) +
    choiceStatus, async values => {
    const patch = { descr: optional(values.descr) };
    for (const [key, picker] of Object.entries(pickers)) {
      const value = picker.value();
      if (!row.id || value !== initial[key].value) patch[key] = value;
    }
    try {
      const saved = await saveRow('demands', patch, row.id);
      updateRow('demands', saved);
      if (saved.linked_tasks?.length) await refresh();
    } catch (error) {
      if (error.status === 409) await loadChoices().catch(() => {});
      throw error;
    }
    toast('需求已保存。');
  });
  const pickers = Object.fromEntries(Object.entries(initial).map(([key, entry]) =>
    [key, bindChoice(form.querySelector(`[data-choice="${key}"]`), entry, { allowCustom: key === 'proj' })]));
  const loadChoices = prepareFormChoices(form, ({ options }) => {
    for (const [key, picker] of Object.entries(pickers)) {
      picker.setOptions(catalogChoiceEntries(options[key]));
    }
  });
}

function personDetail(id) {
  const row = getRow('profiles', id);
  const editable = canEditProfile(row);
  const info = [['团队', row.team], ['岗位', row.role], ['状态', row.status]];
  if (editable) info.push(['联系方式', row.contact], ['工作职责与技能', row.duty], ['备注', row.remark]);
  modal(row.display_name || '成员档案', row.emp_no || '', details(info) + '<div class="dialog-actions">' +
    (editable ? action('编辑', 'person-edit', id, 'button primary') : action('关闭', 'close')) + '</div>');
}
function profileFields(row, newAccount = false) {
  return `<div class="form-grid">
    ${field('姓名', 'display_name', row.display_name, 'required maxlength="100"')}
    ${field(newAccount ? '工号（登录账号）' : '档案工号', 'emp_no', row.emp_no, (newAccount ? 'required ' : '') + 'maxlength="100"')}
    ${suggestions('团队', 'team', row.team, catalogOptions('teams'))}${suggestions('岗位', 'role', row.role, catalogOptions('roles'))}
    ${selectField('状态', 'status', MEMBER_STATUS, row.status || '在职')}${field('联系方式', 'contact', row.contact, 'maxlength="200"')}</div>` +
    area('工作职责与技能', 'duty', row.duty) + area('备注', 'remark', row.remark);
}
function personForm(row = { display_name: state.user.name, emp_no: state.user.account }) {
  if (row.id && !canEditProfile(row)) return;
  modalForm(row.id ? '编辑成员档案' : '建立个人档案', '', profileFields(row), async values => {
    const patch = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, optional(value)]));
    if (!patch.display_name) throw new Error('请填写姓名。');
    if (!row.id) patch.owner_name = patch.display_name;
    updateRow('profiles', await saveRow('profiles', patch, row.id));
    showWorkspace();
    toast('档案已保存。');
  });
}
function accountAdd() {
  modalForm('添加成员', '工号作为登录账号。创建后会显示一次临时密码。', profileFields({}, true), async values => {
    const { display_name, ...rest } = values;
    const result = await post('/api/admin/add-member', { ...rest, name: display_name });
    await refresh();
    if (!state.user) return;
    showTemporaryPassword(result, '成员账号已创建');
    toast('成员账号和档案已创建。');
  }, { submit: '创建成员' });
}
function accountImport() {
  let file;
  modalForm('Excel 导入人员', '每行创建一个成员档案和登录账号。姓名、工号必填。工号用作登录账号，状态留空为在职。',
    `<div class="import-template">
      <a class="button" href="/api/admin/member-import-template" download="人员导入模板.xlsx">下载 Excel 模板</a>
      <span class="muted text-small">填写模板后上传，单次最多 200 人。</span>
    </div>
    <input name="workbook" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden>
    <button type="button" class="import-drop" aria-describedby="import-file-state">
      <strong>点击选文件，或拖到这里</strong>
      <span>支持 .xlsx，最大 2 MB</span>
    </button>
    <p id="import-file-state" class="import-file-state muted text-small" role="status">尚未选择文件</p>`,
    async () => {
      const closeButtons = [...dialog.querySelectorAll('[data-action="close"]')];
      const submitText = submit.textContent;
      dialog.dataset.locked = 'true';
      drop.disabled = true;
      submit.textContent = '正在导入…';
      closeButtons.forEach(button => { button.disabled = true; });
      try {
        const result = await request('/api/admin/import-members', { method: 'POST', file });
        if (state.user) {
          showImportedMembers(result.members);
          await refresh();
        }
      } finally {
        if (dialog.contains(form)) {
          dialog.dataset.locked = 'false';
          drop.disabled = false;
          submit.textContent = submitText;
          closeButtons.forEach(button => { button.disabled = false; });
        }
      }
    }, { submit: '导入人员' });

  const form = dialog.querySelector('form');
  form.classList.add('member-import-form');
  const input = form.elements.workbook;
  const submit = form.querySelector('[type=submit]');
  const drop = form.querySelector('.import-drop');
  const message = form.querySelector('.form-error');
  const status = form.querySelector('#import-file-state');
  submit.disabled = true;

  function choose(files) {
    if (!files.length || drop.disabled) return;
    const [chosen] = files;
    let error = '';
    if (files.length !== 1) error = '一次请选择一个 Excel 文件。';
    else if (!/\.xlsx$/i.test(chosen.name)) error = '请选择 .xlsx 文件。';
    else if (!chosen.size || chosen.size > 2 * 1024 * 1024) error = '请选择不超过 2 MB 的非空文件。';
    file = error ? undefined : chosen;
    status.textContent = file ? '已选择 ' + file.name : '尚未选择文件';
    formError(message, error);
    submit.disabled = !file;
  }

  drop.addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    choose(input.files);
    input.value = '';
  });
  drop.addEventListener('dragover', event => {
    event.preventDefault();
    if (!drop.disabled) drop.classList.add('dragging');
  });
  drop.addEventListener('dragleave', event => {
    if (!drop.contains(event.relatedTarget)) drop.classList.remove('dragging');
  });
  drop.addEventListener('drop', event => {
    event.preventDefault();
    drop.classList.remove('dragging');
    choose(event.dataTransfer.files);
  });
  form.addEventListener('dragover', event => event.preventDefault());
  form.addEventListener('drop', event => event.preventDefault());
}
function showImportedMembers(members) {
  const rows = members.map(({ user, temporaryPassword }) =>
    `<tr><td>${text(user.name)}</td><td>${text(user.account)}</td><td><code>${text(temporaryPassword)}</code></td></tr>`).join('');
  modal('已导入 ' + members.length + ' 名成员', '临时密码仅在此处显示。请分别交给成员，首次登录时需修改。',
    `<div class="import-results">${table(['姓名', '登录账号', '临时密码'], rows, '')}</div>
      <div class="dialog-actions"><button type="button" id="download-import-passwords" class="button">下载临时密码（TXT）</button>
      ${action('完成', 'close', '', 'button primary')}</div>`);
  dialog.querySelector('#download-import-passwords').addEventListener('click', () => {
    const records = members.map(({ user, temporaryPassword }) =>
      [user.name.replace(/[\t\r\n]+/g, ' '), user.account, temporaryPassword].join('\t'));
    saveDownload(new Blob(['姓名\t登录账号\t临时密码\r\n' + records.join('\r\n')], { type: 'text/plain;charset=utf-8' }), '新成员临时密码.txt');
  });
}
function accountReset(id) {
  const account = getRow('accounts', id);
  modalForm('重置账号', '密码留空时会生成新的临时密码，成员首次登录后须修改。', '<div class="form-grid">' +
    field('登录账号', 'account', account.account, 'required maxlength="100"') + field('姓名', 'name', account.name, 'required maxlength="100"') + '</div>' +
    field('新密码', 'password', '', 'type="password" minlength="6" autocomplete="new-password"'), async values => {
    const result = await post('/api/admin/reset-account', { ...values, userId: account.id, resetPassword: !values.password });
    await refresh();
    if (state.user && result.temporaryPassword) showTemporaryPassword(result, '已生成新的临时密码');
    toast('账号已重置。');
  });
}
function changeAccountAdminRole(id) {
  if (!primaryAdmin()) return;
  const account = getRow('accounts', id);
  if (account.is_primary_admin) return;
  const grant = account.role !== '管理员';
  const title = grant ? '授权管理员' : '取消授权管理员';
  const name = (personFor(account)?.display_name || account.name) + ' · ' + account.account;
  const message = '确定将「' + name + '」' + (grant ? '设为管理员' : '还原为普通成员') + '？对方需要重新登录。';
  modalForm(title, message, '', async () => {
    await post('/api/admin/member-role', { userId: account.id, grant });
    await refresh();
    toast(grant ? '已授权管理员。' : '已取消管理员授权。');
  }, { submit: grant ? '确认授权' : '确认取消授权' });
}
function accountWecom(id) {
  const account = getRow('accounts', id);
  modalForm('绑定企业微信', '为「' + account.account + '」填写企业微信通讯录中的成员 UserID。留空保存可解除绑定。',
    field('企业微信 UserID', 'wecomUserId', account.wecom_userid, 'maxlength="64" autocomplete="off"'), async values => {
      const result = await post('/api/admin/member-wecom', { userId: account.id, wecomUserId: values.wecomUserId });
      updateRow('accounts', { ...account, wecom_userid: result.wecomUserId });
      toast('企微通知绑定已更新。');
    });
}
function showTemporaryPassword(result, title) {
  modal(title, '请将临时密码交给该成员。关闭后可通过重置账号生成新密码。',
    field('登录账号', 'account', result.user.account, 'readonly') +
    field('临时密码', 'temporaryPassword', result.temporaryPassword, 'readonly') +
    '<div class="dialog-actions">' + action('完成', 'close', '', 'button primary') + '</div>');
}
function catalog(kind) {
  const label = dictionaries[kind];
  const fieldName = kind === 'teams' ? 'team' : 'role';
  const entries = catalogOptions(kind);
  const rows = entries.map(value => {
    const inUse = state.profiles.filter(person => person[fieldName] === value).length;
    return `<tr><td>${text(value)}</td><td>${inUse}</td><td>${inUse ? '使用中' : action('移除', 'catalog-remove', JSON.stringify([kind, value]), 'link danger')}</td></tr>`;
  }).join('');
  modalForm(label + '选项', '已写入成员档案的选项随档案共享。新增备选项保存在当前浏览器。', table([label, '成员人数', '操作'], rows, '暂无选项。') +
    field('添加' + label, 'value', '', 'required maxlength="100"'), values => {
    const value = trimmed(values.value);
    if (!value) throw new Error('请填写名称。');
    if (entries.includes(value)) throw new Error('这个选项已存在。');
    state.catalog[kind] = [...state.catalog[kind], value];
    storeCatalog();
    render();
    catalog(kind);
  }, { submit: '添加' });
}
function passwordForm(first = false) {
  const current = first ? '' : field('当前密码', 'oldPassword', '', 'type="password" autocomplete="current-password" required');
  const fields = current + field('新密码', 'newPassword', '', 'type="password" autocomplete="new-password" required minlength="6"') +
    field('确认新密码', 'confirm', '', 'type="password" autocomplete="new-password" required minlength="6"');
  modalForm(first ? '设置首次登录密码' : '修改密码', first ? '请先设置至少 6 位的新密码。' : '', fields, async values => {
    if (values.newPassword !== values.confirm) throw new Error('两次输入的新密码不同。');
    await post(first ? '/api/first-password' : '/api/password', { oldPassword: values.oldPassword, newPassword: values.newPassword });
    if (first) {
      state.user.must_change_pwd = false;
      dialog.close();
      await enterWorkspace();
    }
    toast('密码已更新。');
  }, { locked: first });
}
function forcePassword() { passwordForm(true); }

function saveDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
async function downloadTask(id) {
  const task = getRow('tasks', id);
  const blob = await request('/api/attachments/' + encodeURIComponent(task.id), { download: true });
  saveDownload(blob, task.fileName || '附件');
}
async function exportTasks() {
  const [from, to] = weekRange();
  const selected = state.page === 'tasks' ? filteredTasks() : state.tasks.filter(ownTask);
  const teamScope = state.page === 'tasks' && admin() && state.filters.taskScope === 'all';
  let rows = selected.filter(task => inWeek(task.startDate, [from, to]) || inWeek(task.endDate, [from, to]));
  if (!rows.length) rows = selected.filter(task => inWeek(task.dueDate, [from, to]) || ['开发中', '测试中'].includes(task.status));
  if (!rows.length) throw new Error('本周没有可导出的任务。');
  const demandCodes = new Map(state.demands.map(row => [row.id, row.code]));
  const exportRows = rows.map(task => ({
    ...task,
    pri: taskPriority(task.pri),
    collaboratorNames: collaboratorNames(task),
    sourceDemandCode: demandCodes.get(task.demand_id),
    dispatchTime: taskDispatchTime(task)
  }));
  toast('正在整理 ' + rows.length + ' 项任务和附件…');
  const skipped = await exportWeek(exportRows, (teamScope ? '团队' : '本周') + '工作任务_' + from + '_' + to, task => {
    if (!task.sharedFile) throw new Error('附件只保存在桌面客户端。');
    return request('/api/attachments/' + encodeURIComponent(task.id), { download: true });
  });
  toast('已导出 ' + rows.length + ' 项任务' + (skipped ? '，' + skipped + ' 份附件未能下载，详情见压缩包。' : '。'));
}

const actions = {
  go: navigate, close: () => dialog.close(), refresh,
  'guidelines-load': loadGuidelines,
  'guidelines-jump': id => {
    const section = document.getElementById(id);
    if (!section) return;
    section.focus({ preventScroll: true });
    section.scrollIntoView({ block: 'start' });
  },
  logout: async () => { await post('/api/logout'); showAuth(); },
  'task-new': () => taskForm(), 'task-detail': taskDetail, 'task-list': () => navigate('tasks'),
  'task-update': openTaskUpdate,
  'task-delete': id => {
    const row = getRow('tasks', id);
    confirmDelete('删除任务', '确定删除「' + row.title + '」？', async () => {
      await removeRow('tasks', row, '任务已删除。');
      if (row.demand_id != null && state.user) await refresh();
    });
  },
  'demand-new': () => demandForm(), 'demand-edit': id => demandForm(getRow('demands', id)), 'demand-detail': demandDetail,
  'demand-dispatch': id => {
    const demand = getRow('demands', id);
    if (canManageDemand(demand) && !demand.linked_tasks?.length) taskForm({}, demand);
  },
  'demand-owner': demandOwnerForm,
  'demand-collaborators': demandCollaboratorsForm,
  'demand-task': async id => {
    await refresh();
    if (state.user) taskDetail(id);
  },
  'demand-delete': id => {
    const row = getRow('demands', id);
    if (!canDeleteDemand(row)) return;
    const description = '确定删除「' + row.code + '」？' + (row.linked_tasks?.length ? ' 关联任务及其进度和附件会保留。' : '');
    confirmDelete('删除需求', description, async () => {
      await removeRow('demands', row, '需求已删除。');
      if (state.user) await refresh();
    });
  },
  'demand-catalog-load': loadDemandCatalog,
  'demand-catalog-tab': kind => {
    if (!Object.hasOwn(catalogLabels, kind)) return;
    state.demandCatalogKind = kind;
    render();
    content.querySelector('.catalog-tabs [aria-pressed="true"]').focus();
  },
  'demand-option-add': kind => {
    const label = catalogLabels[kind];
    modalForm('新增' + label, '', field(label, 'name', '', 'required maxlength="100"'), async values => {
      const name = trimmed(values.name);
      if (!name) throw new Error('请填写名称。');
      await changeDemandOption(kind, 'add', name);
    }, { submit: '添加' });
  },
  'demand-option-remove': id => {
    const [kind, name] = JSON.parse(id);
    const records = kind === 'proj' || kind === 'proposer' ? '需求' : '任务';
    confirmDelete('删除' + catalogLabels[kind], '确定删除「' + name + '」？已有' + records + '会保留原值。',
      () => changeDemandOption(kind, 'remove', name));
  },
  'person-detail': personDetail, 'person-new': () => personForm(), 'person-edit': id => personForm(getRow('profiles', id)),
  'person-delete': id => {
    const row = getRow('profiles', id);
    confirmDelete('删除成员档案', '确定删除「' + row.display_name + '」的档案？该成员仍可使用原账号登录。', () => removeRow('profiles', row, '成员档案已删除。'));
  },
  'person-status': async id => {
    const row = getRow('profiles', id);
    const status = row.status === '已离职' ? '在职' : '已离职';
    updateRow('profiles', await saveRow('profiles', { status }, id));
    toast('成员档案状态已更新。');
  },
  'account-add': accountAdd, 'account-import': accountImport, 'account-reset': accountReset, 'account-wecom': accountWecom,
  'account-admin-role': changeAccountAdminRole,
  'account-delete': id => {
    const row = getRow('accounts', id);
    confirmDelete('删除成员账号', '确定删除「' + row.account + '」的账号和档案？已登记的任务会保留。', async () => {
      await post('/api/admin/delete-account', { userId: row.id });
      await refresh();
      toast('账号已删除。');
    });
  },
  catalog, 'catalog-remove': id => {
    const [kind, value] = JSON.parse(id);
    state.catalog[kind] = state.catalog[kind].filter(option => option !== value);
    storeCatalog();
    if (kind === 'teams' && state.filters.peopleTeam === value) state.filters.peopleTeam = '';
    render();
    catalog(kind);
  },
  password: () => passwordForm(), download: downloadTask, 'export-week': exportTasks
};

document.addEventListener('click', async event => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.auth) return setAuthMode(button.dataset.auth);
  if (button.dataset.page) return navigate(button.dataset.page);
  if (state.user && state.page === 'tasks' && Object.hasOwn(taskSortDefaults, button.dataset.taskSort)) return toggleTaskSort(button);
  if (button.dataset.listStep && state.user && Object.hasOwn(pagedLists, state.page)) {
    const hadFocus = document.activeElement === button;
    state.listPages[state.page] += Number(button.dataset.listStep);
    const pager = updatePagedList(state.page);
    if (hadFocus && button.disabled) pager.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    return;
  }
  const handle = actions[button.dataset.action];
  if (!handle || !state.user) return;
  button.disabled = true;
  try { await handle(button.dataset.id); }
  catch (error) { toast(error.message); }
  finally { button.disabled = false; }
});
function updateFilter(event) {
  const key = event.target.dataset.filter;
  if (!Object.hasOwn(state.filters, key)) return;
  state.filters[key] = event.target.value;
  if (Object.hasOwn(pagedLists, state.page)) {
    state.listPages[state.page] = 1;
    updatePagedList(state.page);
  } else {
    $('#people-rows').innerHTML = peopleRows() || emptyRow(peopleHeaders.length, '没有匹配的人员档案。');
  }
}
content.addEventListener('input', updateFilter);
dialog.addEventListener('cancel', event => {
  if (dialog.dataset.locked === 'true') event.preventDefault();
});
dialog.addEventListener('close', () => {
  if (!dialog.open) dialog.replaceChildren();
});
guidelinesDialog.addEventListener('cancel', event => event.preventDefault());
guidelinesDialog.addEventListener('close', () => {
  if (!guidelinesDialog.open) guidelinesBody.replaceChildren();
});
guidelinesBody.addEventListener('scroll', unlockGuidelinesConfirmation, { passive: true });
window.addEventListener('resize', unlockGuidelinesConfirmation);
guidelinesConfirm.addEventListener('click', async () => {
  if (guidelinesConfirm.disabled || !guidelinesReachedEnd) return;
  const message = $('#guidelines-confirm-error');
  const session = state.user;
  guidelinesConfirm.disabled = true;
  formError(message, '');
  try {
    await post('/api/guidelines/acknowledge');
    if (session !== state.user) return;
    state.guidelinesPending = false;
    guidelinesDialog.close();
  } catch (error) {
    if (session === state.user) {
      formError(message, error.message);
      guidelinesConfirm.disabled = false;
    }
  }
});
$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const submit = $('#auth-submit');
  const values = Object.fromEntries(new FormData(form));
  const mode = state.mode;
  submit.disabled = true;
  formError($('#auth-error'), '');
  try {
    const result = await post(mode === 'register' ? '/api/register' : '/api/login', { ...values, account: trimmed(values.account) });
    if (!result?.user) throw new Error('服务器没有返回账号信息。');
    form.reset();
    await enter(result.user, result.guidelinesPending);
  } catch (error) {
    showAuth(error.message);
    if (mode !== 'login') {
      setAuthMode(mode);
      formError($('#auth-error'), error.message);
      if (error.status === 403) void loadAuthOptions();
    }
    form.elements.account.value = values.account;
    if (values.name) form.elements.name.value = values.name;
  } finally {
    submit.disabled = false;
  }
});

try {
  const result = await request('/api/me', { silentSession: true });
  if (result?.user) await enter(result.user, result.guidelinesPending);
  else showAuth();
} catch (error) {
  showAuth(error.message);
}

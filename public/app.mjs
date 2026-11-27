import { attachmentLabels, exportWeek } from './export.mjs';
import { ACTIVE_TASK_STATUSES, formatPlanningTime, normalizeTaskPriority, plannedCompletion, TASK_PRIORITIES as PRIORITY } from './task-planning.mjs';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const taskStartDialog = $('#task-start-dialog');
const taskCompleteDialog = $('#task-complete-dialog');
const taskUploadHistoryDialog = $('#task-upload-history-dialog');
const taskHistoryDialog = $('#task-history-dialog');
const taskTransferDialog = $('#task-transfer-dialog');
const guidelinesDialog = $('#guidelines-dialog');
const guidelinesBody = $('#guidelines-dialog-body');
const guidelinesConfirm = $('#confirm-guidelines');
const guidelinesScrollHint = $('#guidelines-scroll-hint');
const STATUS = ['待规划', ...ACTIVE_TASK_STATUSES, '已完成'];
const TASK_STATUS_FILTERS = ['未完成', ...STATUS];
const TASK_KINDS = { L: '临时任务', W: '工作任务' };
const MEMBER_STATUS = ['在职', '开发中', '会议中', '请假', '出差', '调岗', '已离职'];
const dispatchTimeFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Shanghai' });
const PAGE_TITLES = { home: '工作台', tasks: '任务中心', taskLink: '任务详情', demands: '需求中心', projects: '项目管理', projectDetail: '项目详情', demandCatalog: '基础配置', people: '人员管理', board: '数据看板', account: '我的账号', guidelines: '行为规范' };
const dictionaries = { teams: '团队', roles: '岗位' };
const catalogLabels = { proposer: '需求提出方', device_type: '设备类型', project_stage: '项目阶段', task_status: '任务状态' };
const npiStages = ['EVT', 'DVT', 'PVT', 'MP'];
const colors = ['#8c9eb9', '#5879e4', '#cc912d', '#26a980'];
const defaultFilters = {
  taskQuery: '', taskStatus: '未完成', taskPriority: '', taskStage: '', taskTeam: '', taskScope: 'mine',
  demandQuery: '', peopleQuery: '', peopleTeam: ''
};
const listPageSize = 10;
const firstListPages = { home: 1, tasks: 1, demands: 1 };
const state = {
  user: null, tasks: [], demands: [], profiles: [], accounts: [], page: 'home', mode: 'login',
  registrationEnabled: false,
  filters: { ...defaultFilters },
  listPages: { ...firstListPages },
  taskSort: null,
  hiddenTaskFields: new Set(),
  catalog: { teams: [], roles: [] },
  demandCatalog: null, demandCatalogError: '', demandCatalogKind: 'proposer',
  projectCatalog: null, projectCatalogError: '', projectDetail: null, projectDetailError: '', projectStageTab: null,
  guidelines: undefined, guidelinesError: '', guidelinesPending: false,
  loadWarnings: [], workDataLoaded: false
};
let toastTimer;
let demandCatalogLoad;
let projectCatalogLoad;
let projectDetailLoad;
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
const taskPriority = value => {
  const priority = normalizeTaskPriority(value);
  return PRIORITY.includes(priority) ? priority : '中';
};
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
    signal: options.signal,
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
  const attachments = row.attachments ?? [];
  const files = originalLocalFile && row.attach && !attachments.some(file => file.kind === 'legacy')
    ? [...attachments, { id: null, kind: 'legacy', name: row.attach }]
    : attachments;
  return {
    ...row,
    startTime, dueTime,
    startDate: startTime.slice(0, 10),
    endDate: formatPlanningTime(row.completed_at).slice(0, 10) || sharedDate(row.end_time, row.end, row.created_at),
    dueDate: dueTime.slice(0, 10),
    attachments: files
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
function overdue(task, at = Date.now()) {
  if (task.status === '已完成' || !task.dueTime) return false;
  const deadline = Date.parse(task.planned_due_at);
  return Number.isFinite(deadline) ? at > deadline : task.dueDate < formatPlanningTime(new Date(at).toISOString()).slice(0, 10);
}
function assignedToMe(task) { return same(task.assignee_id, state.user.id); }
function canEditTask(task) { return admin() || same(task.creator_id ?? task.owner_id, state.user.id); }
function canUpdateTaskProgress(task) { return canEditTask(task) || assignedToMe(task); }
function canTransferTask(task) { return task.status !== '已完成' && admin(); }
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
  state.demandCatalog = null;
  state.demandCatalogError = '';
  state.demandCatalogKind = 'proposer';
  state.projectCatalog = null;
  state.projectCatalogError = '';
  state.projectDetail = null;
  state.projectDetailError = '';
  state.projectStageTab = null;
  state.guidelines = undefined;
  state.guidelinesError = '';
  state.guidelinesPending = false;
  guidelinesLoad = undefined;
  state.loadWarnings = [];
  state.workDataLoaded = false;
  state.page = 'home';
  state.filters = { ...defaultFilters };
  state.listPages = { ...firstListPages };
  state.taskSort = null;
  state.hiddenTaskFields.clear();
  document.title = '工程小管家';
  if (taskStartDialog.open) taskStartDialog.close('cancel');
  if (taskCompleteDialog.open) taskCompleteDialog.close('cancel');
  if (taskUploadHistoryDialog.open) taskUploadHistoryDialog.close();
  if (taskHistoryDialog.open) taskHistoryDialog.close();
  if (taskTransferDialog.open) taskTransferDialog.close('cancel');
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
  $('[data-page="projects"]').hidden = !admin();
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
function linkedProjectName() {
  return new URLSearchParams(location.search).get('project');
}
async function enter(user, guidelinesPending) {
  state.user = user;
  state.filters.taskScope = admin() ? 'all' : 'mine';
  state.guidelinesPending = guidelinesPending === true;
  state.catalog = loadCatalog();
  state.hiddenTaskFields = loadHiddenTaskFields();
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
  else if (admin() && linkedProjectName() !== null) state.page = 'projectDetail';
  showWorkspace();
  content.innerHTML = '<p class="empty">正在读取工作数据…</p>';
  if (state.guidelinesPending) openGuidelinesNotice();
  if (state.page === 'projectDetail') await loadProjectDetail();
  else await refresh();
}
async function refresh() {
  const session = state.user;
  const version = ++refreshVersion;
  const previous = { tasks: state.tasks, demands: state.demands };
  const requests = [['tasks', '任务', db('tasks', 'select')], ['demands', '需求', db('demands', 'select')], ['profiles', '人员档案', db('profiles', 'select')]];
  if (admin()) requests.push(['accounts', '账号', request('/api/admin/accounts')]);
  const results = await Promise.allSettled(requests.map(row => row[2]));
  if (session !== state.user || version !== refreshVersion) return;
  state.workDataLoaded = true;
  state.loadWarnings = [];
  results.forEach((result, index) => {
    const [field, label] = requests[index];
    if (Object.hasOwn(previous, field) && state[field] !== previous[field]) return;
    const rows = result.value?.[field === 'accounts' ? 'accounts' : 'data'];
    if (result.status === 'fulfilled' && Array.isArray(rows)) {
      if (field === 'tasks') {
        state.tasks = rows.map(normalizeTask);
      } else {
        state[field] = rows;
      }
    } else {
      state.loadWarnings.push(label);
    }
  });
  showWorkspace();
  if (!['projects', 'projectDetail'].includes(state.page)) render();
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
  const { label, sortKey } = typeof header === 'string' ? { label: header } : header;
  if (!sortKey) return `<th scope="col">${text(label)}</th>`;
  const direction = state.taskSort?.key === sortKey ? state.taskSort.direction : null;
  return `<th scope="col"${direction ? ' aria-sort="' + direction + '"' : ''}>
    <button type="button" class="task-sort-button" data-task-sort="${sortKey}">${text(label)}<span class="sort-indicator" aria-hidden="true"></span></button></th>`;
}
function table(headers, rows, empty, bodyId = '') {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(tableHeader).join('')}</tr></thead><tbody${bodyId ? ' id="' + bodyId + '"' : ''}>${rows || emptyRow(headers.length, empty)}</tbody></table></div>`;
}
function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty">${text(message)}</td></tr>`; }
function descCell(value) {
  const tooltip = value ? ` title="${text(value)}"` : '';
  return `<td class="list-desc-cell"><span class="list-desc"${tooltip}>${shown(value)}</span></td>`;
}
function statusBadge(status) {
  const variant = { 开发中: 'start', 测试中: 'test', 已完成: 'done', 在职: 'done', 请假: 'test', 已离职: 'danger' }[status] || '';
  return `<span class="tag ${variant}">${shown(status)}</span>`;
}
function priorityBadge(value, label) {
  const priority = taskPriority(value);
  const variant = { 低: 'done', 中: 'start', 高: 'test', 很高: 'danger', 立即: 'immediate' }[priority];
  return `<span class="tag ${variant}">${text(label ?? priority)}</span>`;
}
function plannedHoursBadge(task, label = '') {
  const hours = withHours(task.planned_hours);
  if (hours === '—') return label ? `<span class="tag">${text(label + hours)}</span>` : hours;
  return priorityBadge(task.pri, label + hours);
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
  const tasks = state.tasks.filter(assignedToMe);
  const active = tasks.filter(task => task.status !== '已完成');
  const week = weekRange();
  const weekly = tasks.filter(task => inWeek(task.endDate, week));
  const queue = [...active].sort((a, b) => (a.dueTime || '9999').localeCompare(b.dueTime || '9999')).slice(0, 8);
  const headers = ['任务编号', '项目', '项目阶段', '状态', '优先级', '计划完成', '计划工时', '任务描述'];
  const at = Date.now();
  const rows = queue.map(task => `<tr>
      <td>${action(task.code, 'task-detail', task.id, 'link task-code')}</td><td>${shown(task.proj)}</td>
      <td>${shown(task.project_stage)}</td><td>${statusBadge(task.status)}</td><td>${priorityBadge(task.pri)}</td>
      ${taskDeadlineCell(task, overdue(task, at))}<td>${plannedHoursBadge(task)}</td>
      ${descCell(task.desc)}
    </tr>`).join('');
  return heading('工作台', myName() ? '你好，' + myName() : '', '' /* action('导出本周任务', 'export-week') */) +
    stats([['我的未完成任务', active.length], ['我的逾期任务', active.filter(task => overdue(task, at)).length], ['我的本周完成工时', sumHours(weekly) + 'h'], ['我的任务完成率', (tasks.length ? Math.round((tasks.length - active.length) / tasks.length * 100) : 0) + '%']]) +
    panel('我的待办', table(headers, rows, '暂无待办任务', 'todo-rows'), action('任务中心', 'go', 'tasks', 'link')) +
    pagedListPanel('home');
}

const taskColumns = [
  { key: 'code', label: '任务编号', cell: task => `<td>${action(task.code, 'task-detail', task.id, 'link task-code')}${task.blocked ? '<small class="text-red">阻塞</small>' : ''}</td>` },
  { key: 'proj', label: '项目', cell: task => `<td>${shown(task.proj)}</td>` },
  { key: 'project_stage', label: '项目阶段', sortKey: 'project_stage', cell: task => `<td>${shown(task.project_stage)}</td>` },
  { key: 'status', label: '状态', cell: task => `<td>${statusBadge(task.status)}</td>` },
  { key: 'pri', label: '优先级', sortKey: 'pri', cell: task => `<td>${priorityBadge(task.pri)}</td>` },
  { key: 'owner_name', label: '负责人', adminOnly: true, cell: task => `<td>${shown(task.owner_name)}</td>` },
  { key: 'startTime', label: '开始时间', sortKey: 'startTime', cell: task => `<td class="task-date">${shown(task.startTime)}</td>` },
  { key: 'dueTime', label: '计划完成时间', sortKey: 'dueTime', cell: taskDeadlineCell },
  { key: 'endDate', label: '完成日期', sortKey: 'endDate', cell: task => `<td class="task-date">${shown(task.endDate)}</td>` },
  { key: 'hours', label: '投入工时', sortKey: 'hours', cell: task => `<td>${text(withHours(task.hours))}</td>` },
  { key: 'desc', label: '任务描述', cell: task => descCell(task.desc) }
];
const taskDisplayFields = taskColumns;
const taskDisplayStorageKey = () => 'yxt-web-task-display-' + state.user.id;
const taskSortDefaults = { project_stage: 'ascending', pri: 'descending', dueTime: 'ascending', startTime: 'ascending', endDate: 'ascending', hours: 'descending' };

function loadHiddenTaskFields() {
  try {
    const saved = JSON.parse(localStorage.getItem(taskDisplayStorageKey()));
    if (Array.isArray(saved)) {
      return new Set(taskDisplayFields.filter(({ key }) => key !== 'code' && saved.includes(key)).map(({ key }) => key));
    }
  } catch { /* The list can still be configured for this session. */ }
  return admin() ? new Set() : new Set(['endDate', 'hours']);
}

function canShowTaskField(field) {
  return !field.adminOnly || admin();
}

function visibleTaskColumns() {
  return taskColumns.filter(column => canShowTaskField(column) && !state.hiddenTaskFields.has(column.key));
}

function taskDisplayOptions() {
  const displayFields = taskDisplayFields.filter(canShowTaskField);
  const fields = displayFields.map(({ key, label }) => `<label>
    <input type="checkbox" name="${key}"${state.hiddenTaskFields.has(key) ? '' : ' checked'}${key === 'code' ? ' disabled' : ''}>
    <span>${text(label)}${key === 'code' ? ' <small class="muted">始终显示</small>' : ''}</span>
  </label>`).join('');
  modalForm('显示选项', '', `<div class="form-grid task-display-options">${fields}</div>`, values => {
    for (const { key } of displayFields) {
      if (key === 'code') continue;
      if (Object.hasOwn(values, key)) state.hiddenTaskFields.delete(key);
      else state.hiddenTaskFields.add(key);
    }
    try { localStorage.setItem(taskDisplayStorageKey(), JSON.stringify([...state.hiddenTaskFields])); }
    catch { /* Keep the selected fields for this session. */ }
    const columns = visibleTaskColumns();
    if (state.taskSort && !columns.some(column => column.sortKey === state.taskSort.key)) {
      state.taskSort = null;
      state.listPages.tasks = 1;
    }
    $('#task-rows').closest('table').tHead.rows[0].innerHTML = columns.map(tableHeader).join('');
    updatePagedList('tasks');
  }, { submit: '应用' });
}

function matchesTaskScope(task, scope) {
  return (scope === 'all' && admin()) || assignedToMe(task);
}

function taskOwnerProfile(task) {
  return task.assignee_id == null ? null : state.profiles.find(person => same(person.owner_id, task.assignee_id));
}

function filteredTasks() {
  const { taskQuery, taskStatus, taskPriority: priority, taskStage, taskTeam, taskScope } = state.filters;
  const isAdmin = admin();
  return state.tasks.filter(task => {
    if (!matchesTaskScope(task, taskScope)) return false;
    if (taskStatus === '未完成' ? task.status === '已完成' : taskStatus && task.status !== taskStatus) return false;
    if (priority && taskPriority(task.pri) !== priority) return false;
    if (taskStage && task.project_stage !== taskStage) return false;
    const ownerProfile = isAdmin ? taskOwnerProfile(task) : null;
    if (isAdmin && taskTeam && ownerProfile?.team !== taskTeam) return false;
    return isAdmin
      ? hasText(taskQuery, task.code, task.desc, task.proj, task.device_type, task.owner_name, ownerProfile?.emp_no)
      : hasText(taskQuery, task.code, task.desc, task.proj, task.device_type);
  });
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
    return multiplier * (typeof left === 'number' ? left - right : sortZh(left, right));
  });
}
function attachmentUrl(taskId, fileId) {
  return '/api/attachments/' + encodeURIComponent(taskId) + '/' + encodeURIComponent(fileId);
}
function taskFiles(task, kind, { allowAppend = true } = {}) {
  const links = task.attachments.filter(file => file.kind === kind).map(file => file.id
    ? `<div><a class="link" href="${attachmentUrl(task.id, file.id)}" download>${text(file.name)}</a></div>`
    : `<div>${text(file.name)} <small class="muted">桌面本地附件</small></div>`);
  const canAppend = allowAppend && (kind === 'requirement' ? task.canAppendRequirement : kind === 'delivery' && task.canAppendDelivery);
  if (canAppend) links.push(action('补传' + attachmentLabels[kind], 'task-attachment-append', JSON.stringify([task.id, kind]), 'link'));
  return links.join('') || '—';
}
function taskDeadlineCell(task, isOverdue) {
  return `<td data-task-deadline="${text(task.id)}" class="task-date task-due-date${isOverdue ? ' text-red' : ''}">${shown(task.dueTime)}</td>`;
}
function taskRows(tasks) {
  const columns = visibleTaskColumns();
  const at = Date.now();
  return tasks.map(task => {
    const isOverdue = overdue(task, at);
    return `<tr>${columns.map(column => column.cell(task, isOverdue)).join('')}</tr>`;
  }).join('');
}
function updateTaskOverdueIndicators() {
  if (state.page !== 'tasks' || !state.user) return;
  const at = Date.now();
  for (const cell of content.querySelectorAll('[data-task-deadline]')) {
    const task = state.tasks.find(row => same(row.id, cell.dataset.taskDeadline));
    if (!task) continue;
    cell.classList.toggle('text-red', overdue(task, at));
  }
}
function tasksPage() {
  const scope = admin() ? `<select aria-label="任务范围" data-filter="taskScope">${option('all', state.filters.taskScope, '所有任务')}${option('mine', state.filters.taskScope, '我负责的任务')}</select>` : '';
  const priority = filterSelect('taskPriority', '按优先级筛选', PRIORITY, '全部优先级');
  const stage = filterSelect('taskStage', '按项目阶段筛选', unique(state.tasks.map(task => task.project_stage)), '全部阶段');
  const team = admin() ? filterSelect('taskTeam', '按负责人团队筛选', unique(state.profiles.map(person => person.team)), '全部团队') : '';
  const placeholder = admin() ? '搜索任务编号、描述、项目、设备类型、负责人或工号' : '搜索任务编号、描述、项目或设备类型';
  const toolbar = `<div class="toolbar">${search('taskQuery', placeholder)}${filterSelect('taskStatus', '按任务状态过滤', TASK_STATUS_FILTERS, '全部状态')}${priority}${stage}${team}${scope}</div>`;
  return heading('任务中心', '跟进任务分工、进度和交付记录。', action('刷新', 'refresh') + action('显示选项', 'task-display-options') +
    /* action('导出本周任务', 'export-week') + */ action('＋ 新建任务', 'task-new', '', 'button primary')) +
    pagedListPanel('tasks', toolbar);
}

const demandHeaders = ['需求编码', '项目', '项目阶段', '任务进度', '当前负责人', '提出方', '创建人', '需求说明'];
function demandOwner(task) {
  return task?.id && canTransferTask(task)
    ? action(task.owner_name || '设置负责人', 'task-transfer', task.id, 'link') : shown(task?.owner_name);
}
function filteredDemands() {
  return state.demands.filter(row => hasText(state.filters.demandQuery, row.code, row.title, row.proj, row.project_stage, row.descr, row.proposer,
    ...(row.linked_tasks || []).flatMap(task => [task.owner_name, task.initial_receiver_name])));
}
function demandCreator(demand) {
  const mine = same(demand.creator_id ?? demand.owner_id, state.user.id);
  return mine ? `${shown(demand.owner_name)}<span class="tag start self-tag">我</span>` : shown(demand.owner_name);
}
function demandRows(demands) {
  return demands.map(demand => {
    const task = demand.linked_tasks?.[0];
    return `<tr>
    <td>${action(demand.code, 'demand-detail', demand.id, 'link')}</td><td>${shown(demand.proj)}</td>
    <td>${shown(demand.project_stage)}</td>
    <td>${task ? statusBadge(task.status) : '<span class="tag">待派发</span>'}</td>
    <td>${demandOwner(task)}</td><td>${shown(demand.proposer)}</td><td>${demandCreator(demand)}</td>
    ${descCell(demand.descr)}</tr>`;
  }).join('');
}
function demandsPage() {
  const toolbar = `<div class="toolbar">${search('demandQuery', '搜索需求编码、项目或任务负责人')}</div>`;
  return heading('需求中心', '登记需求、派发任务并跟踪进度。', action('刷新', 'refresh') + action('＋ 新建需求', 'demand-new', '', 'button primary')) +
    pagedListPanel('demands', toolbar);
}

function handledTasks() {
  return state.tasks.filter(task => task.handled_by_me)
    .sort((a, b) => (b.handled_at || '').localeCompare(a.handled_at || '') || b.id - a.id);
}
function handledTaskRows(tasks) {
  const at = Date.now();
  return tasks.map(task => `<tr>
    <td>${action(task.code, 'task-detail', task.id, 'link task-code')}</td><td>${shown(task.proj)}</td>
    <td>${shown(task.project_stage)}</td><td>${statusBadge(task.status)}</td><td>${priorityBadge(task.pri)}</td>
    ${taskDeadlineCell(task, overdue(task, at))}<td>${shown(task.owner_name)}</td>
    ${descCell(task.desc)}</tr>`).join('');
}
const pagedLists = {
  home: { id: 'handled', title: '我经手的任务', headers: ['任务编号', '项目', '项目阶段', '状态', '优先级', '计划完成', '当前负责人', '任务描述'], items: handledTasks, rows: handledTaskRows, empty: '暂无经手任务。' },
  tasks: { id: 'task', title: '任务列表', get headers() { return visibleTaskColumns(); }, items: sortedTaskList, rows: taskRows, empty: '没有匹配的任务。' },
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
function pagedListPanel(key, toolbar = '') {
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
  if (kind === 'task_status') {
    const rows = ACTIVE_TASK_STATUSES.map(status => `<tr><td>${statusBadge(status)}</td></tr>`).join('');
    return header + panel(label, table([label], rows, '暂无任务状态。'));
  }
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

function projectsPage() {
  const header = heading(PAGE_TITLES.projects, '', state.projectCatalog ? action('＋ 新建项目', 'project-new', '', 'button primary') : '');
  if (!state.projectCatalog) return header + panel('项目列表', projectLoading(state.projectCatalogError, 'project-load'));
  const rows = state.projectCatalog.projects.toSorted((a, b) => sortZh(a.name, b.name)).map(project => `<tr>
    <td><a class="link" data-project-link href="/?project=${encodeURIComponent(project.name.toWellFormed())}">${text(project.name)}</a></td><td>${shown(project.stage)}</td>
    <td>${action('删除', 'project-remove', project.name, 'link danger')}</td></tr>`).join('');
  return header + panel('项目列表', table(['项目名称', '项目阶段', '操作'], rows, '暂无项目。'));
}

function projectLoading(error, retry) {
  return error
    ? `<p class="form-error" role="alert">${text(error)}</p>` + action('重新加载', retry, '', 'link')
    : '<p class="empty" role="status">正在加载项目…</p>';
}

function projectDetailPage() {
  const name = linkedProjectName();
  const header = heading(name || PAGE_TITLES.projectDetail, '', action('返回项目列表', 'project-list'));
  if (!state.projectDetail) return header + panel('项目详情', projectLoading(state.projectDetailError, 'project-detail-load'));

  const { project } = state.projectDetail;
  const stages = catalogOptionNames(state.projectDetail.stages, 'project_stage');
  const retiredStage = !stages.includes(project.stage);
  const options = (retiredStage ? `<option selected disabled>${text(project.stage)}（已从基础配置移除）</option>` : '') +
    stages.map(stage => option(stage, project.stage)).join('');
  const config = `<form id="project-stage-form">
    <div class="project-stage-controls"><label>当前项目阶段<select name="stage">${options}</select></label>
      <button type="submit" class="button primary">保存</button></div>
    <p class="form-error" role="alert" hidden></p>
  </form>`;

  const selected = state.projectStageTab ?? (npiStages.includes(project.stage) ? project.stage : npiStages[0]);
  const tabs = npiStages.map(stage => `<button type="button" class="button" role="tab" id="npi-tab-${stage}" data-project-stage-tab="${stage}"
    aria-controls="npi-panel-${stage}" aria-selected="${stage === selected}" tabindex="${stage === selected ? 0 : -1}">${stage}</button>`).join('');
  const stagePanels = npiStages.map(stage => `<div class="project-stage-table" role="tabpanel" tabindex="0" id="npi-panel-${stage}"
    aria-labelledby="npi-tab-${stage}"${stage === selected ? '' : ' hidden'}>${projectRequirementsTable(stage)}</div>`).join('');
  return header + panel('项目配置', config) + panel('阶段需求', `<div class="catalog-tabs" role="tablist" aria-label="项目阶段需求">${tabs}</div>` +
    stagePanels, action('＋ 新增需求', 'project-requirement-add'));
}

function projectRequirementsTable(stage) {
  const rows = state.projectDetail.requirements[stage].map(item => `<tr>
    <td><button type="button" class="link" data-action="project-requirement-edit" data-id="${text(item.code)}" aria-label="编辑需求 ${text(item.code)}">${text(item.code)}</button></td>
    <td>${shown(item.description)}</td><td>${shown(item.deliverable)}</td>
    <td>${item.planned_hours == null ? '—' : text(item.planned_hours) + ' 小时'}</td></tr>`).join('');
  return table(['编号', '需求说明', '交付内容', '计划投入工时'], rows, '本阶段暂无需求。');
}

function selectProjectStageTab(tab, focus = true) {
  state.projectStageTab = tab.dataset.projectStageTab;
  tab.parentElement.querySelectorAll('[role="tab"]').forEach(item => {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
    document.getElementById(item.getAttribute('aria-controls')).hidden = !selected;
  });
  if (focus) tab.focus({ preventScroll: true });
}

function showProjectStageTab(stage) {
  const tab = document.getElementById('npi-tab-' + stage);
  if (tab) selectProjectStageTab(tab, false);
}

async function loadProjects() {
  if (!admin()) return;
  const session = state.user;
  state.projectCatalogError = '';
  if (state.page === 'projects') render();
  const pending = request('/api/admin/projects', { signal: AbortSignal.timeout(10000) });
  projectCatalogLoad = pending;
  try {
    const result = await pending;
    if (projectCatalogLoad === pending && session === state.user) state.projectCatalog = result;
  } catch (error) {
    if (projectCatalogLoad === pending && session === state.user) state.projectCatalogError = error.message;
  }
  if (projectCatalogLoad === pending && session === state.user && state.page === 'projects') render();
}

async function loadProjectDetail() {
  const session = state.user;
  const name = linkedProjectName();
  state.projectDetail = null;
  state.projectDetailError = '';
  render();
  const pending = request('/api/admin/projects/detail?' + new URLSearchParams({ name }), { signal: AbortSignal.timeout(10000) });
  projectDetailLoad = pending;
  const current = () => projectDetailLoad === pending && session === state.user && state.page === 'projectDetail' && name === linkedProjectName();
  try {
    const result = await pending;
    if (current()) state.projectDetail = result;
  } catch (error) {
    if (current()) state.projectDetailError = error.message;
  }
  if (current()) render();
}

async function changeProject(action, name, stage) {
  const result = await post('/api/admin/projects/change', { action, name, stage });
  projectCatalogLoad = undefined;
  state.projectCatalog = result;
  if (state.page === 'projects') render();
  else if (state.page === 'projectDetail' && state.projectDetail?.project.name === name) {
    state.projectDetail.project = result.projects.find(project => project.name === name);
    state.projectDetail.stages = result.stages;
    state.projectStageTab = null;
    render();
  }
  toast({ create: '项目已新建。', update: '项目阶段已保存。', remove: '项目已删除。' }[action]);
}

function projectForm() {
  if (!admin() || !state.projectCatalog) return;
  modalForm('新建项目', '', field('项目名称', 'name', '', 'required maxlength="100"'), async values => {
    const name = trimmed(values.name);
    if (!name) throw new Error('请填写项目名称。');
    await changeProject('create', name);
  });
}

function projectRequirementForm(code) {
  if (!state.projectDetail) return;
  const { project, requirements } = state.projectDetail;
  const stage = state.projectStageTab ?? (npiStages.includes(project.stage) ? project.stage : npiStages[0]);
  const row = requirements[stage].find(item => item.code === code);
  if (code && !row) return;
  const subtitle = project.name + ' · ' + (row?.code ?? stage);
  const fields = area('需求说明', 'description', row?.description) + area('交付内容', 'deliverable', row?.deliverable) +
    field('计划投入工时（小时）', 'hours', row?.planned_hours, 'type="number" min="0" step="any" inputmode="decimal"');
  async function save(action, values = {}) {
    const result = await post('/api/admin/projects/requirements/change', {
      name: project.name, stage, action, code: row?.code, revision: row?.revision,
      description: values.description, deliverable: values.deliverable,
      planned_hours: values.hours ? Number(values.hours) : null
    });
    if (state.page === 'projectDetail' && state.projectDetail?.project.name === project.name) {
      state.projectDetail.requirements = result.requirements;
      for (const phase of npiStages) {
        document.getElementById('npi-panel-' + phase).innerHTML = projectRequirementsTable(phase);
      }
    }
    toast(action === 'remove' ? '需求已删除。' : '需求已保存。');
  }
  modalForm(row ? '编辑阶段需求' : '新增阶段需求', subtitle, fields, (values, remove) => {
    if (remove) {
      confirmDelete('删除阶段需求', `确定删除「${subtitle}」？`, () => save('remove'));
      return false;
    }
    if (!trimmed(values.description) && !trimmed(values.deliverable)) throw new Error('请填写需求说明或交付内容。');
    return save(row ? 'update' : 'add', values);
  }, { secondarySubmit: row ? '删除' : undefined });
}

function boardPage() {
  const tasks = state.tasks.filter(canUpdateTaskProgress);
  const done = tasks.filter(task => task.status === '已完成');
  const due = done.filter(task => task.dueDate && task.endDate);
  const onTime = due.filter(task => task.endDate <= task.dueDate);
  const hours = grouped(tasks, task => task.proj || '未分类', task => Number(task.hours) || 0);
  const active = tasks.filter(task => task.status !== '已完成');
  const load = grouped(active, task => task.owner_name || '未指定', task => Number(task.hours) || 0)
    .map(([name, value]) => [name, Math.round(value / 40 * 100), value > 40 ? '#b02c42' : '#26a980', Math.round(value / 40 * 100) + '% · ' + value + 'h']);
  const completed = done.slice(0, 12).map(task => `<div class="detail-item">${action(task.code, 'task-detail', task.id, 'link')}<span class="number">${shown(task.endDate)}</span><p class="muted text-small">${shown(task.result)}</p></div>`).join('');
  return heading('数据看板', admin() ? '根据团队可见任务实时计算。' : '根据你可见的任务实时计算。') +
    stats([['任务总数', tasks.length], ['完成率', (tasks.length ? Math.round(done.length / tasks.length * 100) : 0) + '%', done.length + ' 项已完成'],
      ['投入工时', sumHours(tasks) + 'h', tasks.filter(task => task.attachments.length).length + ' 项含附件'], ['按时交付率', due.length ? Math.round(onTime.length / due.length * 100) + '%' : '—', due.length ? onTime.length + ' / ' + due.length + ' 项' : '暂无可统计交付日期']]) +
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

const pages = { home: workspacePage, tasks: tasksPage, taskLink: taskLinkPage, demands: demandsPage, projects: projectsPage, projectDetail: projectDetailPage, demandCatalog: demandCatalogPage,
  people: peoplePage, board: boardPage, account: accountPage, guidelines: guidelinesPage };
function render() {
  if (!state.user) return;
  const navPage = state.page === 'taskLink' ? 'tasks' : state.page === 'projectDetail' ? 'projects' : state.page;
  document.querySelectorAll('[data-page]').forEach(button => {
    const active = button.dataset.page === navPage;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.title = PAGE_TITLES[state.page] + ' · 工程小管家';
  const warnings = state.loadWarnings.length && !['projects', 'projectDetail'].includes(state.page)
    ? `<div class="panel actions" role="status"><span class="text-red">${text(state.loadWarnings.join('、'))}加载失败。</span>${action('重新加载', 'refresh', '', 'link')}</div>` : '';
  content.innerHTML = warnings + pages[state.page]();
}
function navigate(page) {
  if (!Object.hasOwn(pages, page) || (['demandCatalog', 'projects', 'projectDetail'].includes(page) && !admin())) return;
  if (['taskLink', 'projectDetail'].includes(state.page) && page !== state.page) {
    const url = new URL(location.href);
    url.searchParams.delete(state.page === 'taskLink' ? 'task' : 'project');
    history.replaceState(null, '', url);
  }
  state.projectStageTab = null;
  state.page = page;
  if (page === 'demandCatalog') void loadDemandCatalog();
  else if (page === 'projects') void loadProjects();
  else if (page === 'projectDetail') void loadProjectDetail();
  else {
    render();
    if (page === 'guidelines') void loadGuidelines();
    if (['home', 'tasks', 'taskLink', 'demands', 'people'].includes(page) ||
        (!state.workDataLoaded && ['board', 'account'].includes(page))) void refresh();
  }
}

function details(entries, className = 'form-grid') {
  return `<dl class="${className}">${entries.map(([label, value, markup]) => `<div><dt>${text(label)}</dt><dd>${markup ? value : shown(value)}</dd></div>`).join('')}</dl>`;
}
function field(label, name, value = '', attributes = '') {
  return `<label>${label}<input name="${name}" value="${text(value)}" ${attributes}></label>`;
}
function area(label, name, value, required = false) {
  return `<label>${label}<textarea name="${name}" rows="3" maxlength="10000"${required ? ' required' : ''}>${text(value)}</textarea></label>`;
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
function modal(title, description, body, locked = false, headingAside = '', focusTitle = false) {
  const close = locked ? '' : '<button type="button" class="dialog-close" data-action="close" aria-label="关闭">×</button>';
  dialog.dataset.locked = String(locked);
  dialog.innerHTML = `<div class="dialog-heading"><div class="dialog-heading-text"><h2 id="dialog-title"${focusTitle ? ' tabindex="-1" autofocus' : ''}>${text(title)}</h2>${description ? '<p class="muted text-small">' + text(description) + '</p>' : ''}</div>
    ${headingAside ? `<div class="dialog-heading-actions">${headingAside}${close}</div>` : close}</div>${body}`;
  if (!dialog.open) dialog.showModal();
  else if (focusTitle) dialog.querySelector('#dialog-title').focus({ preventScroll: true });
}
function modalForm(title, description, fields, onSave, options = {}) {
  const leading = options.leadingActions ? `<div class="dialog-actions-start">${options.leadingActions}</div>` : '';
  const buttons = options.locked ? action('退出登录', 'logout')
    : options.hideCancel ? ''
    : options.onCancel
      ? `<button type="button" class="button" data-dialog-cancel>${text(options.cancel || '取消')}</button>`
      : action(options.cancel || '取消', 'close');
  const submitClass = options.submitClass || (options.danger ? 'danger' : 'primary');
  const secondary = options.secondarySubmit
    ? `<button type="submit" class="button" value="secondary">${text(options.secondarySubmit)}</button>` : '';
  modal(title, description, `<form id="dialog-form"><div class="stack">${fields}</div><p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions">${leading}${buttons}<button type="submit" class="button ${submitClass}">${text(options.submit || '保存')}</button>${secondary}</div></form>`, options.locked, options.headingAside, options.focusTitle);
  const form = dialog.querySelector('form');
  if (options.onCancel && !options.hideCancel) {
    form.querySelector('[data-dialog-cancel]').addEventListener('click', () => {
      try { options.onCancel(); }
      catch (error) { dialog.close(); toast(error.message); }
    });
  }
  const message = form.querySelector('.form-error');
  const submitButtons = [...form.querySelectorAll('[type=submit]')];
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (submitButtons.some(button => button.disabled)) return;
    submitButtons.forEach(button => { button.disabled = true; });
    formError(message, '');
    const values = Object.fromEntries(new FormData(form));
    try {
      const result = await onSave(values, event.submitter?.value === 'secondary', event.submitter?.value);
      if (result !== false && dialog.contains(form)) dialog.close();
    } catch (error) {
      formError(message, error.message);
    } finally {
      submitButtons.forEach(button => { button.disabled = false; });
    }
  });
  return form;
}
function confirmDelete(title, message, perform, options = {}) {
  modalForm(title, message, '', perform, { danger: true, submit: '确认删除', ...options });
}
function confirmDeleteTask(row, onCancel) {
  confirmDelete('删除任务', '确定删除「' + row.code + '」？', async () => {
    await removeRow('tasks', row, '任务已删除。');
    if (row.demand_id != null && state.user) await refresh();
  }, onCancel ? { onCancel } : {});
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
function taskDemandSection(task, source) {
  if (!source && !Object.hasOwn(task, 'dispatched_at')) return '';
  const code = source ? action(source.code, 'demand-detail', source.id, 'link') : '—';
  const meta = details([
    ['需求编号', code, true],
    ['派发人', task.dispatched_by_name],
    ['派发时间', taskDispatchTime(task)]
  ], 'task-demand-grid');
  const hasRequirementFiles = task.attachments.some(file => file.kind === 'requirement');
  const filesBlock = (hasRequirementFiles || task.canAppendRequirement)
    ? `<div class="task-demand-files"><dt>需求文件</dt><dd>${taskFiles(task, 'requirement')}</dd></div>`
    : '';
  return `<section class="task-demand-section" aria-label="需求信息">
    <h3>需求信息</h3>
    ${meta}
    ${filesBlock}
  </section>`;
}
function taskDetails(task, { editable = {}, hideOwner = false } = {}) {
  const source = state.demands.find(row => same(row.id, task.demand_id));
  const isCompleted = task.status === '已完成';
  const info = details([
    ['任务类型', TASK_KINDS[task.task_kind]],
    ['设备类型', editable.deviceType ? inlineChoiceControl('设备类型', 'device_type') : task.device_type, Boolean(editable.deviceType)],
    ['项目', editable.proj ? inlineChoiceControl('项目', 'proj') : task.proj, Boolean(editable.proj)],
    ['项目阶段', `<span data-task-project-stage>${shown(task.project_stage)}</span>`, true],
    ...(!hideOwner ? [['负责人', task.owner_name]] : []),
    ...(!editable.status ? [['状态', statusBadge(task.status), true]] : []),
    ...(!editable.pri ? [['优先级', priorityBadge(task.pri), true]] : []),
    ['开始时间', task.startTime],
    ['计划完成时间', task.dueTime],
    ...(!editable.status ? [['计划投入工时', plannedHoursBadge(task), true]] : []),
    ...(isCompleted ? [['投入工时', withHours(task.hours)]] : []),
    ...(isCompleted ? [['完成日期', task.endDate]] : []),
    ...(isCompleted ? [['交付文件', taskFiles(task, 'delivery'), true]] : []),
    ...(task.attachments.some(file => file.kind === 'legacy') ? [['历史附件', taskFiles(task, 'legacy'), true]] : [])
  ]);
  const demandSection = taskDemandSection(task, source);
  const remarkItems = [
    ...(editable.desc ? [] : [`<div class="detail-item"><strong>任务描述</strong><p class="muted">${shown(task.desc)}</p></div>`]),
    ...(isCompleted ? [`<div class="detail-item"><strong>完成结果</strong><p class="muted">${shown(task.result)}</p></div>`] : [])
  ].join('');
  const remarks = remarkItems ? `<div class="details-list">${remarkItems}</div>` : '';
  return info + demandSection + remarks;
}
function taskDialogLeadingActions(task) {
  const canDelete = task.status === '已完成' ? admin() : canEditTask(task);
  const remove = canDelete ? '<button type="button" class="button danger" data-task-dialog-action="delete">删除</button>' : '';
  const transfer = canTransferTask(task) ? '<button type="button" class="button" data-task-dialog-action="transfer">转交负责人</button>' : '';
  return remove + transfer;
}
function updateTaskUploadHistoryCount(task) {
  const count = task.attachments.filter(file => file.kind === 'delivery').length;
  for (const button of document.querySelectorAll(`[data-action="task-upload-history"][data-id="${task.id}"]`)) {
    button.textContent = '上传记录' + (count ? '（' + count + '）' : '');
  }
}
function taskDetail(id) {
  const task = getRow('tasks', id);
  const priority = taskPriority(task.pri);
  const hideOwner = state.page === 'tasks' && assignedToMe(task);
  const canOperate = task.status !== '已完成' && canUpdateTaskProgress(task);
  const leadingActions = taskDialogLeadingActions(task);
  if (!canOperate) {
    const footer = leadingActions ? `<div class="dialog-actions"><div class="dialog-actions-start">${leadingActions}</div></div>` : '';
    const headingAside = `<div class="dialog-task-meta">${priorityBadge(priority)}${plannedHoursBadge(task, '计划投入工时 ')}${statusBadge(task.status)}</div>`;
    modal(task.code, '', taskDetails(task, { editable: { pri: true, status: true }, hideOwner }) + taskUploadHistorySection(task) + footer,
      false, headingAside, true);
    dialog.querySelector('[data-task-dialog-action="delete"]')?.addEventListener('click', () => {
      confirmDeleteTask(task, () => taskDetail(task.id));
    });
    return;
  }
  const isPlanning = task.status === '待规划';
  const canEditDetails = canEditTask(task);
  const canEditClassification = canEditTaskClassification(task);
  const canEditProject = canEditDetails && task.demand_id == null;
  const canEditPriority = canEditClassification && !isPlanning;
  const canChangeStatus = ACTIVE_TASK_STATUSES.includes(task.status);
  const optionKinds = canEditClassification ? ['device_type'] : [];
  const needsChoices = canEditProject || optionKinds.length > 0;
  const priorityControl = canEditPriority
    ? selectField('', 'pri', PRIORITY, priority, 'form="dialog-form" aria-label="优先级"')
    : priorityBadge(priority);
  const statusField = canChangeStatus
    ? selectField('', 'status', ACTIVE_TASK_STATUSES, task.status, 'form="dialog-form" aria-label="状态"')
    : statusBadge(task.status);
  const headingAside = `<div class="dialog-task-meta">${priorityControl}${plannedHoursBadge(task, '计划投入工时 ')}${statusField}</div>`;
  const fields = taskDetails(task, {
    editable: { proj: canEditProject, deviceType: canEditClassification, pri: true, status: true, desc: canEditDetails },
    hideOwner
  }) +
    (canEditDetails ? area('任务描述', 'desc', task.desc, false) : '') +
    (canChangeStatus ? taskFileField('delivery') + uploadProgress : '') +
    taskUploadHistorySection(task) +
    (needsChoices ? choiceStatus : '');
  const formOptions = isPlanning
    ? { submit: '开始规划', submitClass: 'primary', hideCancel: true, leadingActions, headingAside, focusTitle: true }
    : { submit: '完成任务', submitClass: 'success', hideCancel: true, leadingActions, headingAside, focusTitle: true };
  let project, loadChoices, completionDraft, planDraftHours;
  let saveQueue = Promise.resolve();
  function collectPendingPatch(values) {
    const latest = getRow('tasks', task.id);
    const patch = {};
    if (canEditProject) {
      const proj = project.value();
      if (proj !== optional(latest.proj)) patch.proj = proj;
    }
    for (const kind of optionKinds) {
      const value = taskOptions.value(kind);
      if (value !== optional(latest[kind])) patch[kind] = value;
    }
    if (canEditDetails) {
      const desc = optional(values.desc);
      if (desc !== optional(latest.desc)) patch.desc = desc;
    }
    if (canEditPriority && values.pri !== taskPriority(latest.pri)) patch.pri = values.pri;
    return patch;
  }
  const form = modalForm(task.code, '', fields, async values => {
    const formUser = state.user;
    await saveQueue;
    if (!formUser || state.user !== formUser || !dialog.open || !dialog.contains(form)) return false;
    const patch = collectPendingPatch(values);

    try {
      if (isPlanning) {
        const plan = await post('/api/tasks/plan-preview', { taskId: task.id });
        if (!formUser || state.user !== formUser || !dialog.open || !dialog.contains(form)) return false;
        const start = await confirmTaskStart(plan, getRow('tasks', task.id), planDraftHours);
        if (!start) return false;
        planDraftHours = start.plannedHours;
        if (!formUser || state.user !== formUser || !dialog.open || !dialog.contains(form)) return false;
        const result = await post('/api/tasks/start', {
          taskId: task.id, startToken: plan.startToken, plannedHours: start.plannedHours, changes: patch
        });
        await applySavedTask(result.task);
        toast('任务已开始。');
        return;
      }
      const latest = getRow('tasks', task.id);
      const hasDeliveryFiles = latest.attachments.some(file => file.kind === 'delivery');
      const completion = await confirmTaskCompletion(completionDraft ?? latest, hasDeliveryFiles);
      if (!completion) return false;
      completionDraft = completion;
      if (!formUser || state.user !== formUser || !dialog.open || !dialog.contains(form)) return false;
      const current = getRow('tasks', task.id);
      const result = await post('/api/tasks/complete', {
        taskId: task.id, expectedVersion: current.version, hours: completion.hours, files: [],
        changes: { ...patch, result: completion.result }
      });
      await applySavedTask(result.task);
      toast('任务已完成。');
    } catch (error) {
      if (error.status === 409 && loadChoices) await loadChoices().catch(() => {});
      if (error.status === 409 && state.user) await refresh();
      throw error;
    }
  }, formOptions);
  const formMessage = form.querySelector('.form-error');
  function autoSave(patch, { rollback, message: toastText = '已保存。' } = {}) {
    const run = async () => {
      const session = state.user;
      if (dialog.contains(form)) formError(formMessage, '');
      try {
        const saved = await saveRow('tasks', patch, task.id);
        if (state.user !== session) return;
        await applySavedTask(saved);
        const updated = normalizeTask(saved);
        const stageEl = dialog.querySelector('[data-task-project-stage]');
        if (stageEl) stageEl.textContent = updated.project_stage || '—';
        toast(toastText);
      } catch (error) {
        rollback?.();
        if (dialog.contains(form)) formError(formMessage, error.message);
        else toast(error.message);
        if (error.status === 409 && loadChoices) await loadChoices().catch(() => {});
        if (error.status === 409 && state.user) await refresh();
      }
    };
    saveQueue = saveQueue.then(run, run);
    return saveQueue;
  }
  const upload = canChangeStatus ? bindFileUploads(form, () => []) : null;
  if (canChangeStatus) {
    const drop = form.querySelector('.file-drop');
    bindTaskFilePicker(form, {
      onFiles: async chosen => {
        const session = state.user;
        drop.disabled = true;
        formError(formMessage, '');
        try {
          const uploaded = await upload('delivery', chosen);
          if (!uploaded.length || state.user !== session || !dialog.open || !dialog.contains(form)) return;
          const attached = await post('/api/tasks/attachments', { taskId: task.id, kind: 'delivery', files: uploaded });
          await applySavedTask(attached.task);
          updateTaskUploadHistoryCount(normalizeTask(attached.task));
          toast('已上传交付文件。');
        } catch (error) {
          formError(formMessage, error.message);
          if (error.status === 409 && state.user) await refresh();
        } finally {
          drop.disabled = false;
        }
      }
    });
    const statusSelect = dialog.querySelector('select[name="status"]');
    statusSelect?.addEventListener('change', () => {
      const latest = getRow('tasks', task.id);
      const nextStatus = statusSelect.value;
      if (nextStatus === latest.status) return;
      statusSelect.disabled = true;
      void autoSave({ status: nextStatus }, {
        rollback: () => { try { statusSelect.value = getRow('tasks', task.id).status; } catch { /* ignore */ } },
        message: '任务状态已更新。'
      }).finally(() => { statusSelect.disabled = false; });
    });
  }
  if (canEditPriority) {
    const priSelect = dialog.querySelector('select[name="pri"]');
    priSelect?.addEventListener('change', () => {
      const latest = getRow('tasks', task.id);
      const nextPri = priSelect.value;
      if (nextPri === taskPriority(latest.pri)) return;
      priSelect.disabled = true;
      void autoSave({ pri: nextPri }, {
        rollback: () => { try { priSelect.value = taskPriority(getRow('tasks', task.id).pri); } catch { /* ignore */ } },
        message: '优先级已更新。'
      }).finally(() => { priSelect.disabled = false; });
    });
  }
  if (canEditDetails) {
    const descField = form.elements.desc;
    descField?.addEventListener('blur', () => {
      let latest;
      try { latest = getRow('tasks', task.id); } catch { return; }
      const nextDesc = optional(descField.value);
      if (nextDesc === optional(latest.desc)) return;
      void autoSave({ desc: nextDesc }, { message: '任务描述已保存。' });
    });
  }
  const taskOptions = bindTaskOptions(form, task, optionKinds, {
    onChange: (kind, value) => {
      const latest = getRow('tasks', task.id);
      if (value === optional(latest[kind])) return;
      void autoSave({ [kind]: value }, {
        rollback: () => { try { taskOptions.setValue(kind, optional(getRow('tasks', task.id)[kind])); } catch { /* ignore */ } }
      });
    }
  });
  if (canEditProject) {
    project = bindChoice(form.querySelector('[data-choice=proj]'), { value: optional(task.proj), label: task.proj }, {
      allowCustom: true,
      onChange: value => {
        const latest = getRow('tasks', task.id);
        if (value === optional(latest.proj)) return;
        void autoSave({ proj: value }, {
          rollback: () => { try { project.setValue(optional(getRow('tasks', task.id).proj)); } catch { /* ignore */ } }
        });
      }
    });
  }
  if (needsChoices) {
    loadChoices = prepareFormChoices(form, ({ options }) => {
      project?.setOptions(catalogChoiceEntries(options.proj));
      taskOptions.setOptions(options);
    });
  }
  form.querySelector('[data-task-dialog-action="delete"]')?.addEventListener('click', () => {
    confirmDeleteTask(getRow('tasks', task.id), () => taskDetail(task.id));
  });
  form.querySelector('[data-task-dialog-action="transfer"]')?.addEventListener('click', async () => {
    await saveQueue;
    if (state.user) taskTransferForm(task.id, { returnToDetail: true });
  });
}
function taskLinkPage() {
  const task = state.tasks.find(row => same(row.id, linkedTaskId()));
  const back = action('返回任务中心', 'task-list');
  if (!task) {
    const message = state.loadWarnings.includes('任务') ? '任务加载失败，请重新加载。' : '找不到该任务，或你没有权限查看。';
    return heading('任务详情', '', back) + '<p class="panel">' + message + '</p>';
  }
  const manage = task.status !== '已完成' && canUpdateTaskProgress(task)
    ? action(task.status === '待规划' ? '开始规划' : '更新任务', 'task-detail', task.id, 'button primary')
    : '';
  return heading(task.code, '', back + manage) + panel('任务详情', taskDetails(task) + taskUploadHistorySection(task));
}

function attachmentUploadTime(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(ms) ? formatPlanningTime(new Date(ms).toISOString()) : '—';
}

function taskUploadHistorySection(task) {
  const count = task.attachments.filter(file => file.kind === 'delivery').length;
  return `<div class="task-upload-history-bar">
    <button type="button" class="button" data-action="task-upload-history" data-id="${text(task.id)}">上传记录${count ? '（' + count + '）' : ''}</button>
    <button type="button" class="button" data-action="task-history" data-id="${text(task.id)}">修改记录</button>
  </div>`;
}

async function openTaskHistory(id) {
  const task = getRow('tasks', id);
  const body = $('#task-history-body');
  $('#task-history-code').textContent = task.code;
  body.innerHTML = '<p class="empty">正在加载修改记录…</p>';
  taskHistoryDialog.showModal();
  const session = state.user;
  try {
    const { history } = await post('/api/tasks/history', { taskId: task.id });
    if (state.user !== session || !taskHistoryDialog.open) return;
    body.innerHTML = history.length
      ? history.map(entry => `<div class="task-history-item">
          <div class="task-history-header">
            <strong>${shown(entry.actor_name)}</strong>
            <time class="muted text-small">${text(attachmentUploadTime(entry.at))}</time>
          </div>
          <p>${text(entry.summary)}</p>
        </div>`).join('')
      : '<p class="empty">暂无修改记录。</p>';
  } catch (error) {
    if (state.user === session && taskHistoryDialog.open) {
      body.innerHTML = `<p class="form-error" role="alert">${text(error.message)}</p>`;
    }
  }
}

let uploadHistoryTaskId = null;

function renderTaskUploadHistory(id) {
  const task = getRow('tasks', id);
  uploadHistoryTaskId = task.id;
  const deliveries = task.attachments
    .filter(file => file.kind === 'delivery')
    .sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0));
  $('#task-upload-history-code').textContent = task.code;
  $('#task-upload-history-body').innerHTML = deliveries.length
    ? deliveries.map(file => {
      const name = file.id
        ? `<strong>${text(file.name)}</strong>`
        : `<strong>${text(file.name)}</strong> <small class="muted">桌面本地附件</small>`;
      const download = file.id
        ? `<a class="button" href="${attachmentUrl(task.id, file.id)}" download>下载</a>`
        : '';
      const remove = file.id && task.canDeleteDelivery
        ? `<button type="button" class="button danger" data-upload-delete="${text(file.id)}">删除</button>`
        : '';
      const actionsHtml = (download || remove) ? `<div class="upload-history-actions">${download}${remove}</div>` : '';
      return `<div class="upload-history-item">
        <div class="upload-history-meta">${name}<time class="muted text-small">${text(attachmentUploadTime(file.created_at))}</time></div>
        ${actionsHtml}
      </div>`;
    }).join('')
    : '<p class="empty">暂无交付文件上传记录。</p>';
}

function openTaskUploadHistory(id) {
  renderTaskUploadHistory(id);
  taskUploadHistoryDialog.showModal();
}

const uploadProgress = '<p class="muted text-small" data-upload-progress role="status" hidden></p>';
function taskFileField(kind, required = false) {
  const title = attachmentLabels[kind] + '（' + (required ? '必填，' : '选填，') + '每次最多 12 个，每个最多 50 MB）';
  return `<div class="file-upload-field" data-file-upload>
    <p class="file-upload-title">${text(title)}</p>
    <input name="files" type="file" multiple hidden>
    <button type="button" class="import-drop file-drop">
      <strong>点击选择文件，或拖拽文件到这里</strong>
      <span>支持多选，每次最多 12 个，单个不超过 50 MB</span>
    </button>
    <ul class="file-selected-list" data-selected-files hidden></ul>
  </div>`;
}

function bindTaskFilePicker(form, { onFiles } = {}) {
  const field = form.querySelector('[data-file-upload]');
  if (!field) return { files: () => [] };
  const input = field.querySelector('input[type="file"]');
  const drop = field.querySelector('.file-drop');
  const list = field.querySelector('[data-selected-files]');
  const message = form.querySelector('.form-error');
  let selected = [];

  function renderSelected() {
    list.hidden = !selected.length;
    list.innerHTML = selected.map((file, index) => `<li>
      <span>${text(file.name)}</span>
      <button type="button" class="link danger" data-file-remove="${index}">移除</button>
    </li>`).join('');
  }

  function addFiles(incoming) {
    const additions = [...incoming].filter(file => file?.name);
    if (!additions.length) return;
    if (onFiles) {
      const valid = [];
      for (const file of additions) {
        if (valid.length >= 12) {
          formError(message, '每次最多上传 12 个文件。');
          break;
        }
        if (!file.size || file.size > 50 * 1024 * 1024) {
          formError(message, '请选择不超过 50 MB 的非空文件。');
          continue;
        }
        if (!file.name.trim() || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) {
          formError(message, '文件名称无效，请重新命名后上传。');
          continue;
        }
        valid.push(file);
      }
      if (valid.length) void onFiles(valid);
      return;
    }
    const next = [...selected];
    for (const file of additions) {
      if (next.length >= 12) {
        formError(message, '每次最多上传 12 个文件。');
        break;
      }
      if (!file.size || file.size > 50 * 1024 * 1024) {
        formError(message, '请选择不超过 50 MB 的非空文件。');
        continue;
      }
      if (!file.name.trim() || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) {
        formError(message, '文件名称无效，请重新命名后上传。');
        continue;
      }
      next.push(file);
    }
    selected = next;
    renderSelected();
  }

  drop.addEventListener('click', () => { if (!drop.disabled) input.click(); });
  input.addEventListener('change', () => {
    formError(message, '');
    addFiles(input.files);
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
    if (drop.disabled) return;
    formError(message, '');
    addFiles(event.dataTransfer?.files || []);
  });
  list.addEventListener('click', event => {
    const remove = event.target.closest('[data-file-remove]');
    if (!remove) return;
    selected.splice(Number(remove.dataset.fileRemove), 1);
    renderSelected();
  });

  return { files: () => selected };
}

function bindFileUploads(form, getFiles) {
  const account = state.user;
  const uploaded = new Map();
  const status = form.querySelector('[data-upload-progress]');
  let closed = false;
  async function discard(files) {
    if (!files.length || state.user !== account) return;
    await post('/api/upload/discard', { ids: files.map(file => uploaded.get(file).id) });
    for (const file of files) uploaded.delete(file);
  }
  dialog.addEventListener('close', () => {
    if (dialog.contains(form) && dialog.open) return;
    closed = true;
    void discard([...uploaded.keys()]).catch(() => {});
  }, { once: true });

  return async (kind, overrideFiles) => {
    const files = [...(overrideFiles ?? getFiles() ?? [])].filter(file => file.name);
    if (files.length > 12) throw new Error('每次最多上传 12 个文件。');
    for (const file of files) {
      if (!file.size || file.size > 50 * 1024 * 1024) throw new Error('请选择不超过 50 MB 的非空文件。');
      if (!file.name.trim() || file.name.length > 255 || /[\x00-\x1f\x7f/\\]/.test(file.name)) {
        throw new Error('文件名称无效，请重新命名后上传。');
      }
    }
    await discard([...uploaded.keys()].filter(file => !files.includes(file)));
    try {
      for (const [index, file] of files.entries()) {
        if (closed || account !== state.user) return [];
        if (uploaded.has(file)) continue;
        status.textContent = '正在上传文件 ' + (index + 1) + ' / ' + files.length + '…';
        status.hidden = false;
        const { id } = await request('/api/upload?kind=' + kind, { method: 'POST', file });
        uploaded.set(file, { id, name: file.name });
        if (closed) { await discard([file]); return []; }
      }
      return files.map(file => uploaded.get(file));
    } finally {
      status.hidden = true;
    }
  };
}

function appendTaskFiles([taskId, kind]) {
  const task = getRow('tasks', taskId);
  const form = modalForm('补传' + attachmentLabels[kind], task.code, taskFileField(kind, true) + uploadProgress, async () => {
    const session = state.user;
    if (!filePicker.files().length) throw new Error('请至少选择一个文件。');
    const files = await upload(kind);
    if (state.user !== session || !dialog.open || !dialog.contains(form)) return false;
    const result = await post('/api/tasks/attachments', { taskId, kind, files });
    updateRow('tasks', normalizeTask(result.task));
    toast('已添加' + attachmentLabels[kind] + '。');
    if (dialog.open && dialog.contains(form)) taskDetail(taskId);
    return false;
  }, { submit: '确认上传' });
  const filePicker = bindTaskFilePicker(form);
  const upload = bindFileUploads(form, () => filePicker.files());
}

async function applySavedTask(row) {
  const saved = normalizeTask(row);
  updateRow('tasks', saved);
  if (saved.demand_id != null) await refresh();
}

function taskTransferForm(id, { returnToDetail = false } = {}) {
  const task = getRow('tasks', id);
  if (!canTransferTask(task)) return;
  let recipient, loadChoices;
  const fields = details([['当前负责人', task.owner_name]], 'task-form-facts') +
    choiceField('接手人（必填）', 'assignee_id', { inlineList: true }) + choiceStatus;
  const form = modalForm('转交负责人', task.code, fields, async () => {
    const session = state.user;
    const { value: assigneeId, label } = recipient.selection();
    if (!Number.isSafeInteger(assigneeId)) throw new Error('请选择接手人。');
    recipient.close();
    if (!(await confirmTaskTransfer(task, label)) || state.user !== session) return false;
    try {
      const result = await post('/api/tasks/transfer', { taskId: task.id, assignee_id: assigneeId, expectedVersion: task.version });
      await applySavedTask(result.task);
    } catch (error) {
      if (error.status === 403 || error.status === 409) await refresh();
      if (error.status === 409) await loadChoices().catch(() => {});
      throw error;
    }
    toast('负责人已转交。');
    if (returnToDetail && state.user) {
      taskDetail(task.id);
      return false;
    }
  }, { submit: '确认转交', onCancel: returnToDetail ? () => taskDetail(task.id) : null });
  recipient = bindChoice(form.querySelector('[data-choice=assignee_id]'), { value: null, label: '' }, { clearable: false, closeOnBlur: false });
  loadChoices = prepareFormChoices(form, ({ people }) => recipient.setOptions(peopleChoices(people)
    .filter(person => !same(person.id, task.assignee_id)).map(({ id, label }) => ({ value: id, label }))));
}

function confirmTaskTransfer(task, recipient) {
  $('#task-transfer-summary').textContent = task.code;
  $('#task-transfer-recipient').textContent = recipient;
  taskTransferDialog.returnValue = 'cancel';
  return new Promise(resolve => {
    taskTransferDialog.addEventListener('close', () => resolve(taskTransferDialog.returnValue === 'transfer'), { once: true });
    taskTransferDialog.showModal();
  });
}

let startDialogContext = null;
const planDueHint = '填写计划投入工时后计算';

function updateStartDialogDuePreview() {
  const input = taskStartDialog.querySelector('[name=plan_hours]');
  const dueDisplay = $('#task-start-due');
  if (!startDialogContext) return;
  const due = plannedCompletion(startDialogContext.startedAt, input.valueAsNumber, startDialogContext.priority);
  dueDisplay.textContent = formatPlanningTime(due) || planDueHint;
}

function confirmTaskStart(plan, task, draftHours) {
  const input = taskStartDialog.querySelector('[name=plan_hours]');
  const priority = normalizeTaskPriority(plan.task?.pri ?? task.pri) || '中';
  startDialogContext = { startedAt: plan.startedAt, priority };
  $('#task-start-priority').innerHTML = priorityBadge(priority);
  $('#task-start-time').textContent = formatPlanningTime(plan.startedAt);
  input.value = draftHours ?? task.planned_hours ?? task.estimated_hours ?? '';
  input.setCustomValidity('');
  updateStartDialogDuePreview();
  taskStartDialog.returnValue = 'cancel';
  return new Promise(resolve => {
    taskStartDialog.addEventListener('close', () => {
      const hours = input.valueAsNumber;
      startDialogContext = null;
      resolve(taskStartDialog.returnValue === 'start' ? { plannedHours: hours } : null);
    }, { once: true });
    taskStartDialog.showModal();
  });
}

function confirmTaskCompletion(draft, hasDeliveryFiles = true) {
  const { result, hours } = taskCompleteDialog.querySelector('form').elements;
  result.value = draft.result ?? '';
  result.setCustomValidity('');
  hours.value = draft.hours ?? '';
  $('#task-complete-no-files').hidden = hasDeliveryFiles;
  taskCompleteDialog.returnValue = 'cancel';
  return new Promise(resolve => {
    taskCompleteDialog.addEventListener('close', () => {
      resolve(taskCompleteDialog.returnValue === 'complete'
        ? { result: trimmed(result.value), hours: hours.valueAsNumber } : null);
    }, { once: true });
    taskCompleteDialog.showModal();
  });
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

function taskForm(demand) {
  const isDispatch = Boolean(demand);
  const priority = taskPriority();
  const dispatchKey = demand && crypto.randomUUID();
  const ownerField = choiceField('负责人', 'assignee_id', { required: isDispatch });
  const identityFields = isDispatch
    ? ownerField
    : `<div class="form-grid">${choiceField('项目', 'proj', { allowCustom: true })}${ownerField}</div>`;
  const kindField = `<label>任务类型（必填）<select name="task_kind" required>
    <option value="" selected disabled>请选择任务类型</option>
    ${Object.entries(TASK_KINDS).map(([value, label]) => option(value, '', label)).join('')}</select></label>`;
  const priorityField = selectField(isDispatch ? '优先级（必填）' : '优先级', 'pri', PRIORITY, priority,
    isDispatch ? 'required' : '');
  const fields = identityFields +
    `<div class="form-grid">${kindField}${priorityField}${taskOptionField('device_type', isDispatch)}</div>` +
    (isDispatch ? field('预计工时（小时，选填）', 'estimated_hours', '', 'type="number" min="0.01" step="0.01" inputmode="decimal"') : '') +
    area(isDispatch ? '任务描述' : '任务描述（必填）', 'desc', demand?.descr, !isDispatch) +
    (isDispatch ? taskFileField('requirement') + uploadProgress : '') +
    choiceStatus;
  let project, owner, loadChoices;
  const form = modalForm(demand ? '派发任务' : '新建任务', demand?.code || '', fields, async values => {
    const formUser = state.user;
    const patch = taskOptions.changes();
    if (!isDispatch) {
      const proj = project.value();
      if (proj !== null) patch.proj = proj;
    }
    const desc = optional(values.desc);
    if (!isDispatch && !desc) throw new Error('请填写任务描述。');
    if (desc !== optional(demand?.descr)) patch.desc = desc;
    patch.pri = values.pri;
    if (!Object.hasOwn(TASK_KINDS, values.task_kind)) throw new Error('请选择临时任务或工作任务。');
    patch.task_kind = values.task_kind;
    const assignee = owner.value();
    if (!Number.isSafeInteger(assignee)) throw new Error('请选择负责人。');
    patch.assignee_id = assignee;
    if (isDispatch && !patch.device_type) throw new Error('请填写设备类型。');
    try {
      if (demand) {
        const files = await upload('requirement');
        if (state.user !== formUser || !dialog.open || !dialog.contains(form)) return false;
        const estimatedHours = values.estimated_hours ? Number(values.estimated_hours) : null;
        const result = await post('/api/demands/dispatch', { demandId: demand.id, dispatchKey, files, task: patch, estimatedHours });
        updateRow('tasks', normalizeTask(result.task));
        updateRow('demands', result.demand);
      } else {
        await applySavedTask(await saveRow('tasks', patch));
      }
    } catch (error) {
      if (error.status === 409 && loadChoices) await loadChoices().catch(() => {});
      if (demand && error.status === 409 && state.user) await refresh();
      throw error;
    }
    toast(demand ? '任务已派发。' : '任务已创建。');
  }, { submit: demand ? '派发任务' : '保存' });
  const filePicker = isDispatch ? bindTaskFilePicker(form) : null;
  const upload = isDispatch ? bindFileUploads(form, () => filePicker.files()) : null;
  const taskOptions = bindTaskOptions(form, {}, ['device_type']);
  if (!isDispatch) {
    project = bindChoice(form.querySelector('[data-choice=proj]'), { value: null, label: '' }, { allowCustom: true });
  }
  owner = bindChoice(form.querySelector('[data-choice=assignee_id]'), {
    value: demand ? null : state.user.id, label: demand ? '' : myName()
  }, { clearable: false });
  loadChoices = prepareFormChoices(form, ({ people, options }) => {
    project?.setOptions(catalogChoiceEntries(options.proj));
    taskOptions.setOptions(options);
    owner.setOptions(peopleChoices(people).map(({ id, label }) => ({ value: id, label })));
  });
}

function inlineChoiceControl(label, key, { allowCustom = true } = {}) {
  const list = `<ul id="choices-${key}" class="choice-list" role="listbox" aria-label="${label}" hidden></ul>`;
  return `<div class="choice-field choice-field-inline" data-choice="${key}">
    <div class="choice-control">
      <input id="choice-${key}" role="combobox" aria-label="${label}" aria-autocomplete="list" aria-expanded="false" aria-controls="choices-${key}"
        autocomplete="off" ${allowCustom ? `maxlength="100" placeholder="请选择或输入${label}"` : 'placeholder="请选择或输入关键词"'} disabled>
      <span aria-hidden="true" class="choice-arrow"></span>
      ${list}
    </div>
  </div>`;
}

function choiceField(label, key, { allowCustom = false, inlineList = false, required = false } = {}) {
  const list = `<ul id="choices-${key}" class="choice-list${inlineList ? ' choice-list-inline' : ''}" role="listbox" aria-label="${label}" hidden></ul>`;
  return `<div class="choice-field" data-choice="${key}">
    <label for="choice-${key}">${label}${required ? '（必填）' : ''}</label>
    <div class="choice-control">
      <input id="choice-${key}" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="choices-${key}"
        autocomplete="off" ${required ? 'required ' : ''}${allowCustom ? `maxlength="100" placeholder="请选择或直接输入${label}"` : 'placeholder="请选择或输入关键词"'} disabled>
      <span aria-hidden="true" class="choice-arrow"></span>
      ${inlineList ? '' : list}
    </div>${inlineList ? list : ''}
  </div>`;
}

function bindChoice(field, initial, { clearable = true, allowCustom = false, closeOnBlur = true, onChange } = {}) {
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
    const prev = selected.value;
    selected = results[index];
    close();
    input.select();
    if (selected.value !== prev) onChange?.(selected.value);
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
    if (!closeOnBlur) return;
    const prev = selected.value;
    if (allowCustom && query !== null) {
      const value = optional(query);
      selected = { value, label: value };
    }
    close();
    if (selected.value !== prev) onChange?.(selected.value);
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
  list.addEventListener('mousedown', event => {
    if (closeOnBlur || event.target.closest('[data-index]')) event.preventDefault();
  });
  list.addEventListener('click', event => {
    const entry = event.target.closest('[data-index]');
    if (entry) choose(Number(entry.dataset.index));
  });

  return {
    value: () => allowCustom && query !== null ? optional(query) : selected.value,
    selection: () => selected,
    close,
    setValue(value) {
      selected = { value: value ?? null, label: value ?? null };
      query = null;
      restore();
    },
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
  if (kind === 'project_stage') return names;
  names.sort(sortZh);
  if (kind !== 'device_type') return names;
  const first = ['PDA', 'POS'];
  return [...first.filter(name => names.includes(name)), ...names.filter(name => !first.includes(name))];
}

function catalogChoiceEntries(values, kind) {
  return catalogOptionNames(values, kind).map(value => ({ value, label: value }));
}

function taskOptionField(kind, required) {
  return choiceField(catalogLabels[kind], kind, { allowCustom: true, required });
}

function bindTaskOptions(form, task, kinds, { onChange } = {}) {
  const fields = kinds.map(kind => {
    const initial = task[kind] ?? null;
    const picker = bindChoice(form.querySelector(`[data-choice=${kind}]`), { value: initial, label: initial }, {
      allowCustom: true,
      onChange: value => onChange?.(kind, value)
    });
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
    value(kind) {
      return fields.find(field => field.kind === kind)?.picker.value() ?? null;
    },
    setValue(kind, value) {
      fields.find(field => field.kind === kind)?.picker.setValue(value);
    },
    setOptions(options) {
      for (const { kind, picker } of fields) picker.setOptions(catalogChoiceEntries(options[kind], kind));
    }
  };
}

function peopleChoices(people) {
  return people.map(({ id, name, emp_no }) => ({ id, label: `${name} · ${emp_no}` }))
    .sort((a, b) => sortZh(a.label, b.label));
}

const choiceStatus = '<div data-choice-retry hidden><button type="button" class="link">重新加载可选项</button></div>';

function prepareFormChoices(form, applyChoices) {
  const submitButtons = form.querySelectorAll('[type=submit]');
  const retry = form.querySelector('[data-choice-retry]');
  const message = form.querySelector('.form-error');
  async function loadChoices() {
    const result = await request('/api/demand-options');
    if (form.isConnected && dialog.open) applyChoices(result);
  }
  async function prepareChoices() {
    submitButtons.forEach(button => { button.disabled = true; });
    retry.hidden = true;
    formError(message, '');
    try {
      await loadChoices();
      submitButtons.forEach(button => { button.disabled = false; });
    } catch (error) {
      formError(message, error.message);
      retry.hidden = false;
    }
  }
  retry.querySelector('button').addEventListener('click', prepareChoices);
  void prepareChoices();
  return loadChoices;
}

function confirmDeleteDemand(row, onCancel) {
  if (!canDeleteDemand(row)) return;
  const description = '确定删除「' + row.code + '」？' + (row.linked_tasks?.length ? ' 关联任务及其进度和附件会保留。' : '');
  confirmDelete('删除需求', description, async () => {
    await removeRow('demands', row, '需求已删除。');
    if (state.user) await refresh();
  }, onCancel ? { onCancel } : {});
}

function demandDetail(id) {
  const demand = getRow('demands', id);
  const tasks = demand.linked_tasks || [];
  const task = tasks[0];
  const canEdit = canManageDemand(demand);
  const canDelete = canDeleteDemand(demand);
  const canDispatch = canEdit && !tasks.length;
  const items = tasks.map(row => `<div class="detail-item demand-task-item">
    <div>${row.id ? action(row.code, 'demand-task', row.id, 'link') : '<strong>任务</strong>'}
    <p class="muted text-small">${shown(row.owner_name)}</p></div>${statusBadge(row.status)}</div>`).join('');
  const info = details([
    ['项目', canEdit ? inlineChoiceControl('项目', 'proj') : demand.proj, canEdit],
    ['项目阶段', `<span data-demand-project-stage>${shown(demand.project_stage)}</span>`, true],
    ['需求提出方', canEdit ? inlineChoiceControl('需求提出方', 'proposer', { allowCustom: false }) : demand.proposer, canEdit],
    ['创建人', demandCreator(demand), true],
    ['任务进度', task ? statusBadge(task.status) : '<span class="tag">待派发</span>', true],
    ['当前负责人', demandOwner(task), true],
    ...(task?.initial_receiver_name ? [['初始接收人', task.initial_receiver_name]] : [])
  ]);
  const descriptionBlock = canEdit
    ? area('需求说明', 'descr', demand.descr, false)
    : `<div class="details-list"><div class="detail-item"><strong>需求说明</strong><p class="muted">${shown(demand.descr)}</p></div></div>`;
  const linkedBlock = `<div class="details-list"><div class="detail-item"><strong>关联任务</strong>${items || '<p class="muted">待派发</p>'}</div></div>`;
  const leading = canDelete ? '<div class="dialog-actions-start"><button type="button" class="button danger" data-demand-dialog-action="delete">删除</button></div>' : '';
  const dispatchBtn = canDispatch ? '<button type="button" class="button primary" data-demand-dialog-action="dispatch">派发任务</button>' : '';
  const footer = (leading || dispatchBtn) ? `<div class="dialog-actions">${leading}${dispatchBtn}</div>` : '';
  const body = `<form id="dialog-form"><div class="stack">${info}${descriptionBlock}${linkedBlock}${canEdit ? choiceStatus : ''}</div><p class="form-error" role="alert" hidden></p>${footer}</form>`;
  modal(demand.code, demand.title, body, false, '', true);
  const form = dialog.querySelector('form');
  form.addEventListener('submit', event => event.preventDefault());
  const formMessage = form.querySelector('.form-error');
  let saveQueue = Promise.resolve();
  let loadChoices;
  function autoSave(patch, { rollback, message: toastText = '已保存。' } = {}) {
    const run = async () => {
      const session = state.user;
      if (dialog.contains(form)) formError(formMessage, '');
      try {
        const saved = await saveRow('demands', patch, demand.id);
        if (state.user !== session) return;
        updateRow('demands', saved);
        const stageEl = dialog.querySelector('[data-demand-project-stage]');
        if (stageEl) stageEl.textContent = saved.project_stage || '—';
        if (saved.linked_tasks?.length) await refresh();
        toast(toastText);
      } catch (error) {
        rollback?.();
        if (dialog.contains(form)) formError(formMessage, error.message);
        else toast(error.message);
        if (error.status === 409 && loadChoices) await loadChoices().catch(() => {});
      }
    };
    saveQueue = saveQueue.then(run, run);
    return saveQueue;
  }
  if (canEdit) {
    const pickers = {
      proj: bindChoice(form.querySelector('[data-choice="proj"]'), { value: demand.proj || null, label: demand.proj }, {
        allowCustom: true,
        onChange: value => {
          const latest = getRow('demands', demand.id);
          if (value === optional(latest.proj)) return;
          void autoSave({ proj: value }, {
            rollback: () => { try { pickers.proj.setValue(optional(getRow('demands', demand.id).proj)); } catch { /* ignore */ } }
          });
        }
      }),
      proposer: bindChoice(form.querySelector('[data-choice="proposer"]'), { value: demand.proposer || null, label: demand.proposer }, {
        allowCustom: false,
        onChange: value => {
          const latest = getRow('demands', demand.id);
          if (value === optional(latest.proposer)) return;
          void autoSave({ proposer: value }, {
            rollback: () => { try { pickers.proposer.setValue(optional(getRow('demands', demand.id).proposer)); } catch { /* ignore */ } }
          });
        }
      })
    };
    loadChoices = prepareFormChoices(form, ({ options }) => {
      for (const [key, picker] of Object.entries(pickers)) {
        picker.setOptions(catalogChoiceEntries(options[key]));
      }
    });
    const descrField = form.elements.descr;
    descrField?.addEventListener('blur', () => {
      let latest;
      try { latest = getRow('demands', demand.id); } catch { return; }
      const nextDescr = optional(descrField.value);
      if (nextDescr === optional(latest.descr)) return;
      void autoSave({ descr: nextDescr }, { message: '需求说明已保存。' });
    });
  }
  form.querySelector('[data-demand-dialog-action="delete"]')?.addEventListener('click', () => {
    confirmDeleteDemand(getRow('demands', demand.id), () => demandDetail(demand.id));
  });
  form.querySelector('[data-demand-dialog-action="dispatch"]')?.addEventListener('click', async () => {
    const descrField = form.elements.descr;
    if (descrField) {
      const latest = getRow('demands', demand.id);
      const nextDescr = optional(descrField.value);
      if (nextDescr !== optional(latest.descr)) await autoSave({ descr: nextDescr }, { message: '需求说明已保存。' });
    }
    await saveQueue;
    if (!state.user) return;
    const current = getRow('demands', demand.id);
    if (canManageDemand(current) && !current.linked_tasks?.length) taskForm(current);
  });
}

function demandForm() {
  const initial = { proj: { value: null, label: '' }, proposer: { value: null, label: '' } };
  const form = modalForm('新建需求', '需求编码将在保存后自动生成。',
    `<div class="form-grid">${choiceField('项目', 'proj', { allowCustom: true })}${choiceField('需求提出方', 'proposer')}</div>` + area('需求说明', 'descr', '') +
    choiceStatus, async values => {
    const patch = { descr: optional(values.descr) };
    for (const [key, picker] of Object.entries(pickers)) patch[key] = picker.value();
    try {
      const saved = await saveRow('demands', patch);
      updateRow('demands', saved);
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
async function exportTasks() {
  const [from, to] = weekRange();
  const selected = state.page === 'tasks' ? filteredTasks() : state.tasks.filter(assignedToMe);
  const teamScope = state.page === 'tasks' && admin() && state.filters.taskScope === 'all';
  let rows = selected.filter(task => inWeek(task.startDate, [from, to]) || inWeek(task.endDate, [from, to]));
  if (!rows.length) rows = selected.filter(task => inWeek(task.dueDate, [from, to]) || ['开发中', '测试中'].includes(task.status));
  if (!rows.length) throw new Error('本周没有可导出的任务。');
  const demandCodes = new Map(state.demands.map(row => [row.id, row.code]));
  const exportRows = rows.map(task => ({
    ...task,
    pri: taskPriority(task.pri),
    sourceDemandCode: demandCodes.get(task.demand_id),
    dispatchTime: taskDispatchTime(task)
  }));
  toast('正在整理 ' + rows.length + ' 项任务和附件…');
  const skipped = await exportWeek(exportRows, (teamScope ? '团队' : '本周') + '工作任务_' + from + '_' + to, (task, file) => {
    if (!file.id) throw new Error('附件只保存在桌面客户端。');
    return request(attachmentUrl(task.id, file.id), { download: true });
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
  'task-new': () => taskForm(), 'task-detail': taskDetail, 'task-upload-history': openTaskUploadHistory, 'task-history': openTaskHistory, 'task-list': () => navigate('tasks'),
  'task-display-options': taskDisplayOptions,
  'task-transfer': id => taskTransferForm(id),
  'demand-new': () => demandForm(), 'demand-detail': demandDetail,
  'demand-task': async id => {
    await refresh();
    if (state.user) taskDetail(id);
  },
  'project-load': loadProjects,
  'project-detail-load': loadProjectDetail,
  'project-new': projectForm,
  'project-list': () => history.state?.fromProjectList ? history.back() : navigate('projects'),
  'project-requirement-add': () => projectRequirementForm(),
  'project-requirement-edit': projectRequirementForm,
  'project-remove': name => {
    if (!admin() || !state.projectCatalog?.projects.some(project => project.name === name)) return;
    confirmDelete('删除项目', `确定删除「${name}」及其阶段需求清单？已有任务和需求会保留项目名称。`, () => changeProject('remove', name));
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
    const records = kind === 'proposer' ? '需求' : kind === 'project_stage' ? '项目' : '任务';
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
  password: () => passwordForm(), 'task-attachment-append': id => appendTaskFiles(JSON.parse(id)), 'export-week': exportTasks
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
content.addEventListener('click', event => {
  const tab = event.target.closest('[data-project-stage-tab]');
  if (tab) selectProjectStageTab(tab);
  const link = event.target.closest('[data-project-link]');
  if (!link || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  history.pushState({ fromProjectList: true }, '', link.href);
  navigate('projectDetail');
});
window.addEventListener('popstate', () => {
  if (!admin()) return;
  if (linkedProjectName() !== null) navigate('projectDetail');
  else if (state.page === 'projectDetail') navigate('projects');
});
content.addEventListener('keydown', event => {
  const tab = event.target.closest('[data-project-stage-tab]');
  if (!tab || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const tabs = [...tab.parentElement.querySelectorAll('[role="tab"]')];
  const index = tabs.indexOf(tab);
  const destination = { ArrowLeft: (index - 1 + tabs.length) % tabs.length, ArrowRight: (index + 1) % tabs.length,
    Home: 0, End: tabs.length - 1 }[event.key];
  selectProjectStageTab(tabs[destination]);
});
content.addEventListener('change', ({ target }) => {
  if (target.form?.id === 'project-stage-form' && target.name === 'stage') showProjectStageTab(target.value);
});
content.addEventListener('submit', async event => {
  const form = event.target;
  if (form.id !== 'project-stage-form') return;
  event.preventDefault();
  const submit = form.querySelector('button[type="submit"]');
  if (submit.disabled) return;
  const project = state.projectDetail?.project;
  const stage = new FormData(form).get('stage');
  if (!project || !stage) return;
  if (stage === project.stage) return showProjectStageTab(stage);
  const errorMessage = form.querySelector('.form-error');
  submit.disabled = true;
  formError(errorMessage, '');
  try { await changeProject('update', project.name, stage); }
  catch (error) { formError(errorMessage, error.message); }
  finally { submit.disabled = false; }
});
setInterval(updateTaskOverdueIndicators, 60_000);
document.addEventListener('visibilitychange', updateTaskOverdueIndicators);
bindPlanHours(taskStartDialog.querySelector('[name=plan_hours]'), updateStartDialogDuePreview);
taskStartDialog.querySelector('[data-start-cancel]').addEventListener('click', () => taskStartDialog.close('cancel'));
taskStartDialog.addEventListener('submit', event => {
  const input = event.target.elements.plan_hours;
  if (startDialogContext && plannedCompletion(startDialogContext.startedAt, input.valueAsNumber, startDialogContext.priority)) return;
  event.preventDefault();
  input.setCustomValidity('请填写有效的计划投入工时，至少为 1 分钟。');
  input.reportValidity();
});
taskStartDialog.querySelector('[name=plan_hours]').addEventListener('input', event => event.target.setCustomValidity(''));
for (const button of taskUploadHistoryDialog.querySelectorAll('[data-upload-history-close]')) {
  button.addEventListener('click', () => taskUploadHistoryDialog.close());
}
$('#task-upload-history-body').addEventListener('click', async event => {
  const button = event.target.closest('[data-upload-delete]');
  if (!button || button.disabled || uploadHistoryTaskId == null) return;
  const task = getRow('tasks', uploadHistoryTaskId);
  const fileId = button.dataset.uploadDelete;
  const file = task.attachments.find(item => item.id === fileId && item.kind === 'delivery');
  if (!file || !window.confirm(`确定删除交付文件「${file.name}」？`)) return;
  const session = state.user;
  button.disabled = true;
  try {
    const result = await post('/api/tasks/attachments/delete', { taskId: task.id, fileId });
    if (state.user !== session) return;
    await applySavedTask(result.task);
    const updated = normalizeTask(result.task);
    updateTaskUploadHistoryCount(updated);
    if (taskUploadHistoryDialog.open) renderTaskUploadHistory(task.id);
    toast('交付文件已删除。');
  } catch (error) {
    toast(error.message);
    if (error.status === 403 || error.status === 404 || error.status === 409) {
      if (state.user) await refresh();
      if (taskUploadHistoryDialog.open && state.user) {
        try { renderTaskUploadHistory(task.id); } catch { taskUploadHistoryDialog.close(); }
      }
    }
  } finally {
    button.disabled = false;
  }
});
for (const button of taskHistoryDialog.querySelectorAll('[data-task-history-close]')) {
  button.addEventListener('click', () => taskHistoryDialog.close());
}
taskCompleteDialog.querySelector('[data-completion-cancel]').addEventListener('click', () => taskCompleteDialog.close('cancel'));
taskCompleteDialog.addEventListener('submit', event => {
  const result = event.target.elements.result;
  if (trimmed(result.value)) return;
  event.preventDefault();
  result.setCustomValidity('请填写完成结果。');
  result.reportValidity();
});
taskCompleteDialog.querySelector('[name=result]').addEventListener('input', event => event.target.setCustomValidity(''));
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

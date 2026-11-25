import { exportWeek } from './export.mjs';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const dialog = $('#dialog');
const STATUS = ['待规划', '开发中', '测试中', '已完成'];
const PRIORITY = ['高', '中', '低'];
const MEMBER_STATUS = ['在职', '开发中', '会议中', '请假', '出差', '调岗', '已离职'];
const PAGE_TITLES = { home: '工作台', tasks: '任务中心', demands: '需求管理', people: '人员管理', board: '数据看板', account: '我的账号' };
const dictionaries = { teams: '团队', roles: '岗位' };
const colors = ['#8c9eb9', '#5879e4', '#cc912d', '#26a980'];
const defaultFilters = { taskQuery: '', taskStatus: '', taskOwner: '', taskScope: 'all', demandQuery: '', peopleQuery: '', peopleTeam: '' };
const state = {
  user: null, tasks: [], demands: [], profiles: [], accounts: [], page: 'home', mode: 'login',
  filters: { ...defaultFilters },
  catalog: { teams: [], roles: [] },
  loadWarnings: []
};
let toastTimer;

function text(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
const shown = value => text(value == null || value === '' ? '—' : value);
const admin = () => state.user?.role === '管理员';
const same = (a, b) => a != null && b != null && String(a) === String(b);
const mineProfile = () => state.profiles.find(person => same(person.owner_id, state.user?.id));
const myName = () => mineProfile()?.display_name || state.user?.name || '';
const sortZh = (a, b) => a.localeCompare(b, 'zh-CN');
const unique = values => [...new Set(values.filter(Boolean))].sort(sortZh);
const trimmed = value => String(value ?? '').trim();
const optional = value => trimmed(value) || null;
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
    throw new Error(data?.message || data?.error || '操作失败，请稍后再试。');
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
  return {
    ...row,
    startDate: sharedDate(row.start_time, row.start, row.created_at),
    endDate: sharedDate(row.end_time, row.end, row.created_at),
    dueDate: dateValue(row.due, row.created_at),
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
function overdue(task) { return task.status !== '已完成' && task.dueDate && task.dueDate < isoDate(); }
function ownTask(task) {
  return same(task.creator_id ?? task.owner_id, state.user.id) || same(task.assignee_id, state.user.id);
}
function canEditTask(task) { return admin() || same(task.creator_id ?? task.owner_id, state.user.id); }
function canDeleteDemand(demand) { return admin() || same(demand.creator_id ?? demand.owner_id, state.user.id); }

function loadCatalog() {
  try {
    const saved = JSON.parse(localStorage.getItem('yxt-web-catalog-' + state.user.id) || '{}');
    return { teams: Array.isArray(saved?.teams) ? saved.teams : [], roles: Array.isArray(saved?.roles) ? saved.roles : [] };
  } catch { return { teams: [], roles: [] }; }
}
function storeCatalog() { localStorage.setItem('yxt-web-catalog-' + state.user.id, JSON.stringify(state.catalog)); }

function showAuth(error = '') {
  state.user = null;
  state.tasks = [];
  state.demands = [];
  state.profiles = [];
  state.accounts = [];
  state.loadWarnings = [];
  state.page = 'home';
  state.filters = { ...defaultFilters };
  document.title = '工程小管家';
  dialog.close();
  $('#loading-view').hidden = true;
  $('#workspace').hidden = true;
  $('#auth-view').hidden = false;
  const form = $('#auth-form');
  form.reset();
  setAuthMode('login');
  formError($('#auth-error'), error);
}
function setAuthMode(mode) {
  state.mode = mode;
  const register = mode === 'register';
  const form = $('#auth-form');
  $('#auth-name').hidden = !register;
  form.elements.name.disabled = !register;
  form.elements.name.required = register;
  form.elements.password.minLength = register ? 6 : 1;
  form.elements.password.autocomplete = register ? 'new-password' : 'current-password';
  $('#auth-title').textContent = register ? '注册工作台账号' : '登录工作台';
  $('#auth-submit').textContent = register ? '注册并登录' : '登录';
  document.querySelectorAll('[data-auth]').forEach(button => {
    button.classList.toggle('active', button.dataset.auth === mode);
    button.setAttribute('aria-pressed', String(button.dataset.auth === mode));
  });
  formError($('#auth-error'), '');
}
function showWorkspace() {
  $('#loading-view').hidden = true;
  $('#auth-view').hidden = true;
  $('#workspace').hidden = false;
  const label = myName() || state.user.account;
  $('#avatar').textContent = label.slice(0, 1);
  $('#user-name').textContent = label;
  $('#user-role').textContent = state.user.role;
  $('#today').dateTime = isoDate();
  $('#today').textContent = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'full' }).format(new Date());
}
async function enter(user) {
  state.user = user;
  state.catalog = loadCatalog();
  if (user.must_change_pwd) {
    $('#loading-view').hidden = true;
    $('#auth-view').hidden = true;
    forcePassword();
    return;
  }
  showWorkspace();
  content.innerHTML = '<p class="empty">正在读取工作数据…</p>';
  await refresh();
}
async function refresh() {
  const session = state.user;
  const requests = [['tasks', '任务', db('tasks', 'select')], ['demands', '需求', db('demands', 'select')], ['profiles', '人员档案', db('profiles', 'select')]];
  if (admin()) requests.push(['accounts', '账号', request('/api/admin/accounts')]);
  const results = await Promise.allSettled(requests.map(row => row[2]));
  if (session !== state.user) return;
  state.loadWarnings = [];
  results.forEach((result, index) => {
    const [field, label] = requests[index];
    const rows = result.value?.[field === 'accounts' ? 'accounts' : 'data'];
    if (result.status === 'fulfilled' && Array.isArray(rows)) {
      state[field] = field === 'tasks' ? rows.map(normalizeTask) : rows;
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
function table(headers, rows, empty, bodyId = '') {
  return `<div class="table-wrap"><table><thead><tr>${headers.map(label => '<th scope="col">' + text(label) + '</th>').join('')}</tr></thead><tbody${bodyId ? ' id="' + bodyId + '"' : ''}>${rows || emptyRow(headers.length, empty)}</tbody></table></div>`;
}
function emptyRow(columns, message) { return `<tr><td colspan="${columns}" class="empty">${text(message)}</td></tr>`; }
function statusBadge(status) {
  const variant = { 开发中: 'start', 测试中: 'test', 已完成: 'done', 在职: 'done', 请假: 'test', 已离职: 'danger' }[status] || '';
  return `<span class="tag ${variant}">${shown(status)}</span>`;
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
  const weekly = tasks.filter(task => inWeek(task.endDate, weekRange()));
  const queue = [...active].sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999')).slice(0, 8);
  const rows = queue.map(task => `<tr><td>${action(task.title, 'task-detail', task.id, 'link')}</td><td>${shown(task.proj)}</td><td>${statusBadge(task.status)}</td><td class="${overdue(task) ? 'text-red' : ''}">${shown(task.dueDate)}</td></tr>`).join('');
  return heading('工作台', myName() ? '你好，' + myName() : '', action('导出本周任务', 'export-week') + action('＋ 新建任务', 'task-new', '', 'button primary')) +
    stats([['我的未完成任务', active.length], ['我的逾期任务', active.filter(overdue).length], ['我的本周完成工时', sumHours(weekly) + 'h'], ['我的任务完成率', (tasks.length ? Math.round((tasks.length - active.length) / tasks.length * 100) : 0) + '%']]) +
    `<div class="grid-two">${panel('我的待办', table(['任务', '项目', '状态', '计划完成'], rows, '暂无待办任务'), action('任务中心', 'go', 'tasks', 'link'))}${panel('我的任务状态', distribution(tasks))}</div>`;
}

const taskHeaders = ['任务', '项目', '状态', '负责人', '计划完成', '开始 / 完成', '工时', '附件', '操作'];
function filteredTasks() {
  const { taskQuery, taskStatus, taskOwner, taskScope } = state.filters;
  return state.tasks.filter(task => (taskScope !== 'mine' || ownTask(task)) &&
    (!taskStatus || task.status === taskStatus) && (!taskOwner || task.owner_name === taskOwner) &&
    hasText(taskQuery, task.title, task.id, task.proj, task.desc, task.result));
}
function fileAction(task) {
  if (!task.fileName) return '—';
  return task.sharedFile
    ? action(task.fileName, 'download', task.id, 'link')
    : `<span title="原附件保存在桌面客户端电脑上">${text(task.fileName)}<small class="muted">桌面本地附件</small></span>`;
}
function taskRows() {
  return filteredTasks().map(task => `<tr>
    <td>${action(task.title || '未命名任务', 'task-detail', task.id, 'link')}<span class="number">#${text(task.id)}</span>${task.blocked ? '<small class="text-red">阻塞</small>' : ''}</td>
    <td>${shown(task.proj)}</td><td>${statusBadge(task.status)}</td><td>${shown(task.owner_name)}</td>
    <td class="${overdue(task) ? 'text-red' : ''}">${shown(task.dueDate)}</td>
    <td>${shown(task.startDate)}<small class="muted">${shown(task.endDate)}</small></td><td>${text(withHours(task.hours))}</td><td>${fileAction(task)}</td>
    <td><div class="row-actions">${canEditTask(task) ? action('编辑', 'task-edit', task.id, 'link') + action('删除', 'task-delete', task.id, 'link danger') : '—'}</div></td></tr>`).join('');
}
function tasksPage() {
  const owners = unique(state.tasks.map(task => task.owner_name));
  const scope = `<select aria-label="任务范围" data-filter="taskScope">${option('all', state.filters.taskScope, admin() ? '全部任务' : '可见任务')}${option('mine', state.filters.taskScope, '我的任务')}</select>`;
  const toolbar = `<div class="toolbar">${search('taskQuery', '搜索任务、编号或项目')}${filterSelect('taskStatus', '按任务状态过滤', STATUS, '全部状态')}${filterSelect('taskOwner', '按负责人过滤', owners, '全部负责人')}${scope}</div>`;
  return heading('任务中心', '跟进任务负责人、进度和交付记录。', action('导出本周任务', 'export-week') + action('＋ 新建任务', 'task-new', '', 'button primary')) +
    panel('任务列表', toolbar + table(taskHeaders, taskRows(), '没有匹配的任务。', 'task-rows'), '<span id="task-count" class="muted text-small">' + filteredTasks().length + ' 项</span>');
}

const demandHeaders = ['需求', '项目', '需求说明', '责任人', '提出方', '创建人', '操作'];
function demandRows() {
  return state.demands.filter(row => hasText(state.filters.demandQuery, row.title, row.proj, row.descr, row.responsible, row.proposer)).map(demand => `<tr>
    <td><strong>${shown(demand.title)}</strong></td><td>${shown(demand.proj)}</td><td>${shown(demand.descr)}</td>
    <td>${shown(demand.responsible)}</td><td>${shown(demand.proposer)}</td><td>${shown(demand.owner_name)}</td>
    <td><div class="row-actions">${action('编辑', 'demand-edit', demand.id, 'link')}${canDeleteDemand(demand) ? action('删除', 'demand-delete', demand.id, 'link danger') : ''}</div></td></tr>`).join('');
}
function demandsPage() {
  return heading('需求管理', '登记需求来源与责任分工。', action('＋ 新建需求', 'demand-new', '', 'button primary')) +
    panel('需求列表', `<div class="toolbar">${search('demandQuery', '搜索需求、项目或责任人')}</div>` + table(demandHeaders, demandRows(), '没有匹配的需求。', 'demand-rows'));
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
function peopleRows() {
  const { peopleQuery, peopleTeam } = state.filters;
  return state.profiles.filter(person => (!peopleTeam || person.team === peopleTeam) &&
    hasText(peopleQuery, person.display_name, person.emp_no, person.team, person.role, person.duty)).map(person => {
    const self = same(person.owner_id, state.user.id);
    const active = state.tasks.filter(task => task.owner_name === person.display_name && task.status !== '已完成');
    return `<tr>
      <td>${action(person.display_name || '未填写姓名', 'person-detail', person.id, 'link')}<small class="muted">${shown(person.emp_no)}</small></td>
      <td>${shown(person.team)}</td><td>${shown(person.role)}</td><td>${statusBadge(person.status)}</td>
      <td>${active.length} 项 <small class="muted">${sumHours(active)}h</small></td>
      <td><div class="row-actions">${action('编辑', 'person-edit', person.id, 'link')}${admin() && !self ? action(person.status === '已离职' ? '恢复在职' : '标记离职', 'person-status', person.id, 'link') + action('删档案', 'person-delete', person.id, 'link danger') : ''}</div></td>
    </tr>`;
  }).join('');
}
function accountsRows() {
  return state.accounts.map(account => `<tr><td>${shown(account.account)}</td><td>${shown(personFor(account)?.display_name || account.name)}</td><td>${shown(account.role)}</td>
    <td>${account.must_change_pwd ? '<span class="tag test">待首次改密</span>' : '已设置'}</td><td><div class="row-actions">${account.role !== '管理员' ? action('重置账号', 'account-reset', account.id, 'link') + action('删账号', 'account-delete', account.id, 'link danger') : '—'}</div></td></tr>`).join('');
}
function peoplePage() {
  const person = mineProfile();
  const buttons = action(person ? '编辑我的档案' : '建立我的档案', person ? 'person-edit' : 'person-new', person?.id) +
    (admin() ? action('＋ 添加成员', 'account-add', '', 'button primary') : '');
  const toolbar = `<div class="toolbar">${search('peopleQuery', '搜索姓名、工号或技能')}${filterSelect('peopleTeam', '按团队过滤', catalogOptions('teams'), '全部团队')}</div>`;
  return heading('人员管理', admin() ? '维护成员档案、在岗状态和登录账号。' : '管理你的个人档案。', buttons) +
    panel(admin() ? '成员档案' : '我的档案', toolbar + table(peopleHeaders, peopleRows(), '暂无人员档案。', 'people-rows'),
      admin() ? '<div class="actions">' + action('团队选项', 'catalog', 'teams', 'link') + action('岗位选项', 'catalog', 'roles', 'link') + '</div>' : '') +
    (admin() ? panel('登录账号', table(accountHeaders, accountsRows(), '暂无账号。')) : '');
}
function accountPage() {
  const description = admin() ? '管理员密码由服务器环境文件管理。' : '查看登录信息和修改密码。';
  const actions = admin() ? '' : action('修改密码', 'password', '', 'button primary');
  return heading('我的账号', description, actions) +
    panel('账号信息', details([['账号', state.user.account], ['姓名', myName()], ['系统权限', state.user.role]]));
}

const pages = { home: workspacePage, tasks: tasksPage, demands: demandsPage, people: peoplePage, board: boardPage, account: accountPage };
function render() {
  if (!state.user) return;
  document.querySelectorAll('[data-page]').forEach(button => {
    const active = button.dataset.page === state.page;
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
  if (!Object.hasOwn(pages, page)) return;
  state.page = page;
  render();
}

function details(entries) {
  return `<dl class="form-grid">${entries.map(([label, value, markup]) => `<div><dt>${text(label)}</dt><dd>${markup ? value : shown(value)}</dd></div>`).join('')}</dl>`;
}
function field(label, name, value = '', attributes = '') {
  return `<label>${label}<input name="${name}" value="${text(value)}" ${attributes}></label>`;
}
function area(label, name, value) {
  return `<label>${label}<textarea name="${name}" rows="3" maxlength="10000">${text(value)}</textarea></label>`;
}
function selectField(label, name, values, current) {
  const options = [...new Set([...values, current])].filter(value => value != null);
  return `<label>${label}<select name="${name}">${options.map(value => option(value, current)).join('')}</select></label>`;
}
function suggestions(label, name, value, values) {
  return field(label, name, value, 'maxlength="100" list="list-' + name + '"') +
    `<datalist id="list-${name}">${values.map(value => '<option value="' + text(value) + '"></option>').join('')}</datalist>`;
}
function formError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}
function modal(title, description, body, locked = false) {
  dialog.dataset.locked = String(locked);
  dialog.innerHTML = `<div class="dialog-heading"><div><h2 id="dialog-title">${text(title)}</h2>${description ? '<p class="muted text-small">' + text(description) + '</p>' : ''}</div>
    ${locked ? '' : '<button type="button" class="dialog-close" data-action="close" aria-label="关闭">×</button>'}</div>${body}`;
  if (!dialog.open) dialog.showModal();
}
function modalForm(title, description, fields, onSave, options = {}) {
  const buttons = options.locked ? action('退出登录', 'logout') : action('取消', 'close');
  modal(title, description, `<form><div class="stack">${fields}</div><p class="form-error" role="alert" hidden></p>
    <div class="dialog-actions">${buttons}<button type="submit" class="button ${options.danger ? 'danger' : 'primary'}">${text(options.submit || '保存')}</button></div></form>`, options.locked);
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
      await onSave(values);
      if (dialog.contains(form)) dialog.close();
    } catch (error) {
      formError(message, error.message);
    } finally {
      button.disabled = false;
    }
  });
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
  if (existing === -1) state[key].unshift(row);
  else state[key][existing] = row;
  render();
}
async function removeRow(tableName, row, success) {
  const result = await db(tableName, 'delete', undefined, row.id);
  if (!result?.data?.length) throw new Error('服务器没有删除这条记录，请刷新后重试。');
  state[tableName] = state[tableName].filter(item => !same(item.id, row.id));
  render();
  toast(success);
}

function taskDetail(id) {
  const task = getRow('tasks', id);
  const info = details([['项目', task.proj], ['负责人', task.owner_name], ['状态', statusBadge(task.status), true], ['优先级', task.pri],
    ['计划完成', task.dueDate], ['工时', withHours(task.hours)], ['开始日期', task.startDate], ['完成日期', task.endDate],
    ['附件', fileAction(task), true], ['前置依赖', task.deps]]);
  const remarks = `<div class="details-list"><div class="detail-item"><strong>任务描述</strong><p class="muted">${shown(task.desc)}</p></div>
    <div class="detail-item"><strong>完成结果</strong><p class="muted">${shown(task.result)}</p></div></div>`;
  const quick = task.status === '已完成' ? '' : action('推进到下一状态', 'task-next', task.id, 'button primary');
  modal(task.title || '任务详情', '#' + task.id, info + remarks + `<div class="dialog-actions">${action('关闭', 'close')}
    ${canEditTask(task) ? action('编辑', 'task-edit', task.id) + quick : ''}</div>`);
}
function taskForm(task = {}) {
  const people = unique([myName(), ...state.profiles.map(person => person.display_name), ...state.tasks.map(row => row.owner_name)]);
  const fields = field('任务名称', 'title', task.title, 'required maxlength="180"') + `<div class="form-grid">
    ${field('项目', 'proj', task.proj, 'maxlength="100"')}${suggestions('负责人', 'owner_name', task.owner_name ?? myName(), people)}
    ${selectField('状态', 'status', STATUS, task.status || STATUS[0])}${selectField('优先级', 'pri', PRIORITY, task.pri || '中')}
    ${field('计划完成', 'due', task.dueDate, 'type="date"')}${field('投入工时（小时）', 'hours', task.hours, 'type="number" min="0" step="0.01"')}
    ${field('开始日期', 'start', task.startDate, 'type="date"')}${field('完成日期', 'end', task.endDate, 'type="date"')}</div>` +
    area('任务描述', 'desc', task.desc) + area('完成结果', 'result', task.result) +
    field('附件（单个文件最多 20MB）', 'file', '', 'type="file"') +
    (task.fileName ? '<p class="muted text-small">当前附件：' + text(task.fileName) + '</p>' : '');
  modalForm(task.id ? '编辑任务' : '新建任务', task.id ? '#' + task.id : '', fields, async values => {
    const end = values.end || (values.status === '已完成' ? isoDate() : '');
    const title = trimmed(values.title);
    if (!title) throw new Error('请填写任务名称。');
    if (values.start && end && end < values.start) throw new Error('完成日期应在开始日期之后。');
    const patch = {
      title, proj: optional(values.proj), owner_name: optional(values.owner_name),
      status: values.status, pri: values.pri, due: optional(values.due),
      start: optional(values.start.slice(5)), start_time: optional(values.start),
      end: optional(end.slice(5)), end_time: optional(end),
      hours: values.hours === '' ? null : Number(values.hours), desc: optional(values.desc), result: optional(values.result)
    };
    if (values.file?.name) {
      if (!values.file.size || values.file.size > 20 * 1024 * 1024) throw new Error('请选择不超过 20MB 的非空附件。');
      const uploaded = await request('/api/upload', { method: 'POST', file: values.file });
      Object.assign(patch, { attachment_path: uploaded.path, attachment_name: values.file.name });
    }
    const saved = await saveRow('tasks', patch, task.id);
    updateRow('tasks', normalizeTask(saved));
    toast(task.id ? '任务已更新。' : '任务已创建。');
  });
}
async function nextTask(id) {
  const task = getRow('tasks', id);
  const next = STATUS[Math.min(STATUS.indexOf(task.status) + 1, STATUS.length - 1)];
  if (!canEditTask(task) || next === task.status) return;
  const patch = { status: next };
  if (next === '已完成' && !task.endDate) {
    patch.end_time = isoDate();
    patch.end = patch.end_time.slice(5);
  }
  updateRow('tasks', normalizeTask(await saveRow('tasks', patch, id)));
  taskDetail(id);
  toast('任务状态已更新。');
}

function demandForm(row = {}) {
  modalForm(row.id ? '编辑需求' : '新建需求', '', field('需求名称', 'title', row.title, 'required maxlength="180"') +
    `<div class="form-grid">${field('项目', 'proj', row.proj, 'maxlength="100"')}${field('责任人', 'responsible', row.responsible, 'maxlength="100"')}
    ${field('需求提出方', 'proposer', row.proposer, 'maxlength="100"')}</div>` + area('需求说明', 'descr', row.descr), async values => {
    const title = trimmed(values.title);
    if (!title) throw new Error('请填写需求名称。');
    const patch = { title, proj: optional(values.proj), descr: optional(values.descr), responsible: optional(values.responsible), proposer: optional(values.proposer) };
    if (!row.id) patch.owner_name = myName();
    updateRow('demands', await saveRow('demands', patch, row.id));
    toast('需求已保存。');
  });
}

function personDetail(id) {
  const row = getRow('profiles', id);
  modal(row.display_name || '成员档案', row.emp_no || '', details([['团队', row.team], ['岗位', row.role], ['状态', row.status], ['联系方式', row.contact],
    ['工作职责与技能', row.duty], ['备注', row.remark]]) + '<div class="dialog-actions">' + action('编辑', 'person-edit', id, 'button primary') + '</div>');
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
      showWorkspace();
      await refresh();
    }
    toast('密码已更新。');
  }, { locked: first });
}
function forcePassword() { passwordForm(true); }

async function downloadTask(id) {
  const task = getRow('tasks', id);
  const blob = await request('/api/attachments/' + encodeURIComponent(task.id), { download: true });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = task.fileName || '附件';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
}
async function exportTasks() {
  const [from, to] = weekRange();
  const selected = state.page === 'tasks' ? filteredTasks() : state.tasks.filter(ownTask);
  const teamScope = state.page === 'tasks' && admin() && state.filters.taskScope !== 'mine';
  let rows = selected.filter(task => inWeek(task.startDate, [from, to]) || inWeek(task.endDate, [from, to]));
  if (!rows.length) rows = selected.filter(task => inWeek(task.dueDate, [from, to]) || ['开发中', '测试中'].includes(task.status));
  if (!rows.length) throw new Error('本周没有可导出的任务。');
  toast('正在整理 ' + rows.length + ' 项任务和附件…');
  const skipped = await exportWeek(rows, (teamScope ? '团队' : '本周') + '工作任务_' + from + '_' + to, task => {
    if (!task.sharedFile) throw new Error('附件只保存在桌面客户端。');
    return request('/api/attachments/' + encodeURIComponent(task.id), { download: true });
  });
  toast('已导出 ' + rows.length + ' 项任务' + (skipped ? '，' + skipped + ' 份附件未能下载，详情见压缩包。' : '。'));
}

const actions = {
  go: navigate, close: () => dialog.close(), refresh,
  logout: async () => { await post('/api/logout'); showAuth(); },
  'task-new': () => taskForm(), 'task-detail': taskDetail,
  'task-edit': id => taskForm(getRow('tasks', id)), 'task-next': nextTask,
  'task-delete': id => {
    const row = getRow('tasks', id);
    confirmDelete('删除任务', '确定删除「' + row.title + '」？', () => removeRow('tasks', row, '任务已删除。'));
  },
  'demand-new': () => demandForm(), 'demand-edit': id => demandForm(getRow('demands', id)),
  'demand-delete': id => {
    const row = getRow('demands', id);
    confirmDelete('删除需求', '确定删除「' + row.title + '」？', () => removeRow('demands', row, '需求已删除。'));
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
  'account-add': accountAdd, 'account-reset': accountReset,
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
  if (key.startsWith('task')) {
    $('#task-rows').innerHTML = taskRows() || emptyRow(taskHeaders.length, '没有匹配的任务。');
    $('#task-count').textContent = filteredTasks().length + ' 项';
  } else if (key.startsWith('demand')) {
    $('#demand-rows').innerHTML = demandRows() || emptyRow(demandHeaders.length, '没有匹配的需求。');
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
    await enter(result.user);
  } catch (error) {
    showAuth(error.message);
    if (mode !== 'login') {
      setAuthMode(mode);
      formError($('#auth-error'), error.message);
    }
    form.elements.account.value = values.account;
    if (values.name) form.elements.name.value = values.name;
  } finally {
    submit.disabled = false;
  }
});

try {
  const result = await request('/api/me', { silentSession: true });
  if (result?.user) await enter(result.user);
  else showAuth();
} catch (error) {
  showAuth(error.message);
}

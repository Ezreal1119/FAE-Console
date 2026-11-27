import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { isAdmin, openAccounts, sessionSeconds } from './backend/accounts.mjs';
import { MEMBER_IMPORT_LIMIT_BYTES, readMemberWorkbook } from './backend/member-import.mjs';
import { openRecords } from './backend/records.mjs';
import { openStore, RequestError } from './backend/store.mjs';
import { openWecomNotifications } from './backend/wecom-notifications.mjs';

const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const secureCookie = process.env.SECURE_COOKIE === '1' ? '; Secure' : '';
const trustProxy = process.env.TRUST_PROXY === '1';
const sessionCookie = 'fae_console_session';
const attachmentLimit = 20 * 1024 * 1024;
const dataDirectory = process.env.DATA_DIR ? resolve(process.env.DATA_DIR) : fileURLToPath(new URL('./data/', import.meta.url));
const store = openStore(dataDirectory);
const guidelinesFile = process.env.CREDENTIALS_DIRECTORY
  ? resolve(process.env.CREDENTIALS_DIRECTORY, 'guidelines.json')
  : new URL('./private/guidelines.json', import.meta.url);
const guidelines = await readFile(guidelinesFile, 'utf8').then(source => {
  const document = JSON.parse(source);
  if (document === null) return null;
  if (!document?.title || !Array.isArray(document.sections) || !document.sections.length) {
    throw new Error('行为规范内容不完整');
  }
  return document;
}).catch(error => {
  if (error.code !== 'ENOENT') console.error('行为规范加载失败：', error.code || error.name);
  return null;
});
const accounts = openAccounts(store, process.env, { guidelinesEnabled: guidelines !== null });
const records = openRecords(store, openWecomNotifications(store, process.env.WECOM_GROUP_WEBHOOK_URL));

const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/task-planning.mjs', ['task-planning.mjs', 'text/javascript; charset=utf-8']],
  ['/export.mjs', ['export.mjs', 'text/javascript; charset=utf-8']]
]);
const apiRoutes = new Map([
  ['/api/auth-options', 'GET'], ['/api/login', 'POST'], ['/api/register', 'POST'], ['/api/logout', 'POST'],
  ['/api/me', 'GET'], ['/api/password', 'POST'], ['/api/first-password', 'POST'],
  ['/api/guidelines', 'GET'], ['/api/guidelines/acknowledge', 'POST'],
  ['/api/admin/accounts', 'GET'], ['/api/admin/add-member', 'POST'],
  ['/api/admin/member-import-template', 'GET'], ['/api/admin/import-members', 'POST'],
  ['/api/admin/reset-account', 'POST'], ['/api/admin/delete-account', 'POST'],
  ['/api/admin/member-wecom', 'POST'],
  ['/api/admin/member-role', 'POST'], ['/api/admin/projects', 'GET'], ['/api/admin/projects/change', 'POST'],
  ['/api/demand-options', 'GET'], ['/api/admin/demand-options', 'POST'], ['/api/demands/dispatch', 'POST'],
  ['/api/tasks/plan-preview', 'POST'], ['/api/tasks/start', 'POST'], ['/api/tasks/complete', 'POST'], ['/api/tasks/transfer', 'POST'],
  ['/api/tasks/comments', 'POST'], ['/api/tasks/comments/change', 'POST'],
  ['/api/db', 'POST'], ['/api/upload', 'POST']
]);
let importingMembers = false;

class RateLimit {
  constructor() {
    this.entries = new Map();
    this.window = 10 * 60 * 1000;
    const cleanup = setInterval(() => {
      const now = Date.now();
      for (const [key, entry] of this.entries) if (entry.expires <= now) this.entries.delete(key);
    }, this.window);
    cleanup.unref();
  }

  attempt(key, limit) {
    const now = Date.now();
    let entry = this.entries.get(key);
    if (!entry || entry.expires <= now) {
      if (this.entries.size >= 10000 && !entry) throw new RequestError(429, '请求过于频繁，请稍后再试。');
      entry = { count: 0, expires: now + this.window };
      this.entries.set(key, entry);
    }
    if (entry.count >= limit) throw new RequestError(429, '请求过于频繁，请稍后再试。');
    entry.count++;
  }

  clear(key) {
    this.entries.delete(key);
  }
}
const authAttempts = new RateLimit();

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
  if (Number(req.headers['content-length']) > limit) {
    req.resume();
    throw new RequestError(413, '请求内容超过大小限制。');
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) {
      req.resume();
      throw new RequestError(413, '请求内容超过大小限制。');
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function readJson(req) {
  const raw = await readBody(req, 128 * 1024);
  try {
    const data = raw.length ? JSON.parse(raw) : {};
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new RequestError(400, '无法读取请求内容。');
  }
}

function sessionHeader(token = '') {
  return sessionCookie + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + (token ? sessionSeconds : 0) + secureCookie;
}

function sessionToken(req) {
  const cookie = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(sessionCookie + '='));
  return cookie?.slice(sessionCookie.length + 1) || '';
}

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '请从工作台页面发起操作。');
  if (!req.headers.origin) return;
  let origin;
  try { origin = new URL(req.headers.origin); }
  catch { throw new RequestError(403, '请求来源无效。'); }
  if (origin.host !== req.headers.host) throw new RequestError(403, '请从工作台页面发起操作。');
}

function clientAddress(req) {
  const address = req.socket.remoteAddress;
  if (trustProxy && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
    return req.headers['x-forwarded-for'] || address;
  }
  return address;
}

function sessionFor(req, path) {
  const session = accounts.getSession(sessionToken(req));
  if (path === '/api/logout') return session;
  if (!session) throw new RequestError(401, '请先登录。');
  if (session.user.must_change_pwd && !['/api/me', '/api/first-password'].includes(path)) {
    throw new RequestError(403, '请先设置首次登录密码。');
  }
  if (path.startsWith('/api/admin/') && !isAdmin(session.user)) {
    throw new RequestError(403, '仅管理员可以执行此操作。');
  }
  return session;
}

function disposition(name) {
  const encoded = encodeURIComponent(name.toWellFormed()).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
  return "attachment; filename*=UTF-8''" + encoded;
}

async function download(res, user, id) {
  const { fd, name, size } = records.openAttachment(user, id);
  const stream = createReadStream(null, { fd });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': disposition(name),
    'Cache-Control': 'private, no-store'
  });
  await pipeline(stream, res);
}

function privateApi(path, session, body) {
  switch (path) {
    case '/api/me': return accounts.me(session);
    case '/api/guidelines': return { guidelines };
    case '/api/guidelines/acknowledge':
      accounts.acknowledgeGuidelines(session);
      return {};
    case '/api/password':
    case '/api/first-password':
      accounts.changePassword(session, body, path === '/api/first-password');
      return {};
    case '/api/admin/accounts': return accounts.list();
    case '/api/admin/member-wecom': return accounts.setWecomUserId(session.user, body);
    case '/api/admin/member-role': return accounts.setAdminRole(session.user, body);
    case '/api/admin/projects': return records.projectCatalog();
    case '/api/admin/projects/change': return records.changeProject(body);
    case '/api/demand-options': return records.demandChoices();
    case '/api/admin/demand-options': return records.changeDemandOptions(body);
    case '/api/demands/dispatch': return records.dispatchDemand(session.user, body);
    case '/api/tasks/plan-preview': return records.previewTaskPlan(session.user, body);
    case '/api/tasks/start': return records.startTask(session.user, body);
    case '/api/tasks/complete': return records.completeTask(session.user, body);
    case '/api/tasks/transfer': return records.transferTask(session.user, body);
    case '/api/tasks/comments': return records.listTaskComments(session.user, body);
    case '/api/tasks/comments/change': return records.changeTaskComment(session.user, body);
    case '/api/admin/add-member': return accounts.addMember(body);
    case '/api/admin/reset-account': return accounts.resetMember(body);
    case '/api/admin/delete-account':
      accounts.deleteMember(body.userId);
      return {};
    case '/api/db': return records.query(session.user, body);
    default: throw new RequestError(404, '接口不存在。');
  }
}

async function handleApi(req, res, path, attachmentId) {
  if (path === '/api/auth-options') {
    return sendJson(res, 200, { ok: true, registrationEnabled: accounts.registrationEnabled });
  }
  if (path === '/api/login' || path === '/api/register') {
    const body = await readJson(req);
    const key = path + ':' + clientAddress(req);
    const signIn = path === '/api/login';
    authAttempts.attempt(key, signIn ? 30 : 10);
    const { token, user, guidelinesPending } = signIn ? accounts.signIn(body) : accounts.register(body);
    if (signIn) authAttempts.clear(key);
    return sendJson(res, 200, { ok: true, user, guidelinesPending }, { 'Set-Cookie': sessionHeader(token) });
  }

  const session = sessionFor(req, path);
  if (path === '/api/logout') {
    accounts.signOut(session);
    return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionHeader() });
  }
  if (attachmentId) return await download(res, session.user, attachmentId);
  if (path === '/api/admin/member-import-template') {
    const template = await readFile(new URL('./backend/templates/member-import.xlsx', import.meta.url));
    res.writeHead(200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Length': template.length,
      'Content-Disposition': disposition('人员导入模板.xlsx'),
      'Cache-Control': 'private, no-store'
    });
    return res.end(template);
  }
  if (path === '/api/admin/import-members') {
    const file = await readBody(req, MEMBER_IMPORT_LIMIT_BYTES);
    sessionFor(req, path);
    if (importingMembers) throw new RequestError(409, '已有人员导入正在处理，请稍后再试。');
    importingMembers = true;
    try {
      const prepared = await accounts.prepareMemberImport(await readMemberWorkbook(file));
      if (res.destroyed) return;
      sessionFor(req, path);
      return sendJson(res, 200, { ok: true, members: accounts.importMembers(prepared) });
    } finally {
      importingMembers = false;
    }
  }
  if (path === '/api/upload') {
    const body = await readBody(req, attachmentLimit);
    const current = sessionFor(req, path);
    return sendJson(res, 200, { ok: true, ...records.upload(current.user, body) });
  }

  const body = req.method === 'POST' ? await readJson(req) : undefined;
  const current = req.method === 'POST' ? sessionFor(req, path) : session;
  return sendJson(res, 200, { ok: true, ...privateApi(path, current, body) });
}

const server = createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path === '/favicon.ico' && req.method === 'GET') {
      res.writeHead(204);
      return res.end();
    }
    const asset = assets.get(path);
    if (asset && ['GET', 'HEAD'].includes(req.method)) {
      const [filename, type] = asset;
      const content = await readFile(new URL('./public/' + filename, import.meta.url));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': content.length });
      return res.end(req.method === 'HEAD' ? undefined : content);
    }
    const attachmentId = path.match(/^\/api\/attachments\/(\d+)$/)?.[1];
    const method = apiRoutes.get(path) || (attachmentId ? 'GET' : undefined);
    if (!method) throw new RequestError(404, '页面或接口不存在。');
    if (req.method !== method) throw new RequestError(405, '请求方法不受支持。');
    if (method === 'POST') checkOrigin(req);

    await handleApi(req, res, path, attachmentId);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const known = error instanceof RequestError;
    const status = known ? error.status : 500;
    const message = known ? error.message : '服务暂时不可用，请稍后再试。';
    if (!known) console.error('请求处理失败：', error.code || error.message);
    const clearCookie = status === 401 && !['/api/login', '/api/register'].includes(req.url);
    sendJson(res, status, { ok: false, error: message, message }, clearCookie ? { 'Set-Cookie': sessionHeader() } : {});
  }
});

server.listen(port, host, () => {
  console.log('工程小管家 Web · http://' + host + ':' + server.address().port);
});

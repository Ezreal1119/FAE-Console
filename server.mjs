import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const upstream = new URL(process.env.WORKBUDDY_URL || 'https://yxt-workbench-58776.app.workbuddy.host');
const shareCode = process.env.WORKBUDDY_SHARE_CODE;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '127.0.0.1';
const secureCookie = process.env.SECURE_COOKIE === '1' ? '; Secure' : '';
const sessionCookie = 'yxt_session';
const attachmentLimit = 20 * 1024 * 1024;
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.css', ['app.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/export.mjs', ['export.mjs', 'text/javascript; charset=utf-8']]
]);
const apiRoutes = new Map([
  ['/api/login', 'POST'], ['/api/register', 'POST'], ['/api/logout', 'POST'],
  ['/api/me', 'GET'], ['/api/password', 'POST'], ['/api/first-password', 'POST'],
  ['/api/admin/accounts', 'GET'], ['/api/admin/add-member', 'POST'],
  ['/api/admin/reset-account', 'POST'], ['/api/admin/delete-account', 'POST'],
  ['/api/db', 'POST']
]);
const writableFields = {
  profiles: ['display_name', 'emp_no', 'role', 'team', 'status', 'contact', 'duty', 'remark', 'owner_name'],
  tasks: ['title', 'proj', 'owner_name', 'status', 'pri', 'due', 'start', 'end', 'start_time', 'end_time', 'hours', 'result', 'desc', 'attachment_name', 'attachment_path', 'attach', 'attachPath'],
  demands: ['title', 'proj', 'descr', 'responsible', 'proposer', 'owner_name']
};

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

async function readBody(req, limit) {
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
  const maxAge = token ? 30 * 86400 : 0;
  return sessionCookie + '=' + encodeURIComponent(token) + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + maxAge + secureCookie;
}

function getSession(req) {
  const entry = (req.headers.cookie || '').split(';').map(value => value.trim()).find(value => value.startsWith(sessionCookie + '='));
  if (!entry) return '';
  try { return decodeURIComponent(entry.slice(sessionCookie.length + 1)); }
  catch { return ''; }
}

async function forward(path, { method = 'GET', body, token, query } = {}) {
  const url = new URL(path, upstream);
  if (shareCode) url.searchParams.set('sharecode', shareCode);
  if (token) url.searchParams.set('token', token);
  if (query) for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  try {
    return await fetch(url, {
      method,
      headers: { Accept: 'application/json, application/octet-stream', ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(30000)
    });
  } catch {
    throw new RequestError(502, '暂时无法连接 WorkBuddy 后端，请稍后再试。');
  }
}

async function upstreamJson(response) {
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new RequestError(502, 'WorkBuddy 没有返回 API 数据，请核对服务地址和分享访问配置。');
  }
  return data;
}

function dbRequest(data) {
  const { table, op, eq, payload } = data;
  const fields = Object.hasOwn(writableFields, table) && writableFields[table];
  if (!fields || !['select', 'insert', 'update', 'delete'].includes(op)) {
    throw new RequestError(400, '不支持的数据操作。');
  }
  const query = { table, op };
  if (op === 'select') {
    if (table !== 'profiles') query.order = ['created_at', false];
  } else if (op === 'update' || op === 'delete') {
    if (!Array.isArray(eq) || eq[0] !== 'id' || !Number.isSafeInteger(Number(eq[1])) || Number(eq[1]) < 1) {
      throw new RequestError(400, '记录编号无效。');
    }
    query.eq = ['id', Number(eq[1])];
  }
  if (op === 'insert' || op === 'update') {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new RequestError(400, '没有可保存的内容。');
    query.payload = Object.fromEntries(fields.flatMap(field => {
      if (!Object.hasOwn(payload, field)) return [];
      const value = payload[field];
      if (value === null || ['number', 'string'].includes(typeof value)) return [[field, value]];
      throw new RequestError(400, '字段格式无效。');
    }));
  }
  return query;
}

function checkOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new RequestError(403, '请从工作台页面发起操作。');
  if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    throw new RequestError(403, '请从工作台页面发起操作。');
  }
}

async function upload(req, res, token) {
  const file = await readBody(req, attachmentLimit);
  if (!file.length) throw new RequestError(400, '请选择非空文件。');
  const postfix = String(req.headers['x-file-extension'] || '').match(/^[a-z0-9]{1,12}$/i)?.[0];
  const response = await forward('/api/upload', {
    method: 'POST', token,
    body: { name: 'attachment' + (postfix ? '.' + postfix : ''), data: file.toString('base64') }
  });
  const data = await upstreamJson(response);
  if (response.status === 401) return sendJson(res, 401, data, { 'Set-Cookie': sessionHeader() });
  if (!data.path || data.error) throw new RequestError(502, data.error || data.message || '附件保存失败。');
  sendJson(res, 200, { path: data.path });
}

function disposition(name) {
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
  return "attachment; filename*=UTF-8''" + encoded;
}

async function download(res, token, id) {
  const listResponse = await forward('/api/db', { method: 'POST', token, body: { table: 'tasks', op: 'select' } });
  const list = await upstreamJson(listResponse);
  if (listResponse.status === 401) return sendJson(res, 401, list, { 'Set-Cookie': sessionHeader() });
  if (!Array.isArray(list.data)) throw new RequestError(502, '无法读取任务附件信息。');
  const task = list.data.find(row => String(row.id) === id);
  const name = task?.attachment_path;
  const originalLocalFile = task?.attachPath && /^(?:[a-z]:[\\/]|[\\/])/i.test(task.attachPath);
  if (originalLocalFile || !name || !/^[\p{L}\p{N}_. -]{1,220}$/u.test(name) || name === '.' || name === '..') {
    throw new RequestError(404, '这条任务没有可下载的服务器附件。');
  }

  const response = await forward('/files/' + encodeURIComponent(name), { token });
  if (response.status === 404) throw new RequestError(404, '服务器上找不到这份附件。');
  if (!response.ok || !response.body || !response.headers.get('content-disposition')?.startsWith('attachment')) {
    throw new RequestError(502, 'WorkBuddy 未能提供这份附件。');
  }
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': disposition(task.attachment_name || '附件'),
    'Cache-Control': 'private, no-store'
  });
  await pipeline(Readable.fromWeb(response.body), res);
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
      const content = await readFile(fileURLToPath(new URL('./public/' + filename, import.meta.url)));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': content.length });
      return res.end(req.method === 'HEAD' ? undefined : content);
    }

    const plannedMethod = apiRoutes.get(path);
    const attachmentId = path.match(/^\/api\/attachments\/(\d+)$/)?.[1];
    const method = plannedMethod || (path === '/api/upload' ? 'POST' : attachmentId ? 'GET' : undefined);
    if (!method) throw new RequestError(404, '页面或接口不存在。');
    if (req.method !== method) throw new RequestError(405, '请求方法不受支持。');
    if (method === 'POST') checkOrigin(req);

    const token = getSession(req);
    const signingIn = path === '/api/login' || path === '/api/register';
    if (path === '/api/logout') {
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': sessionHeader() });
    }
    if (!signingIn && !token) throw new RequestError(401, '请先登录。');
    if (path === '/api/upload') return await upload(req, res, token);
    if (attachmentId) return await download(res, token, attachmentId);

    let body = method === 'POST' ? await readJson(req) : undefined;
    if (path === '/api/db') body = dbRequest(body);
    const response = await forward(path, { method, body, token: signingIn ? undefined : token });
    const data = await upstreamJson(response);
    const headers = {};
    if (response.status === 401) headers['Set-Cookie'] = sessionHeader();
    if (signingIn && data.ok) {
      if (!data.token || typeof data.token !== 'string') throw new RequestError(502, '后端没有返回有效的登录凭证。');
      headers['Set-Cookie'] = sessionHeader(data.token);
    }
    delete data.token;
    sendJson(res, response.status, data, headers);
  } catch (error) {
    if (res.headersSent) return res.destroy();
    const message = error instanceof RequestError ? error.message : '服务暂时不可用，请稍后再试。';
    sendJson(res, error.status || 500, { ok: false, error: message, message });
  }
});

server.listen(port, host, () => {
  console.log('工程小管家 Web · http://' + host + ':' + port);
  if (!shareCode && upstream.hostname.endsWith('.app.workbuddy.host')) {
    console.log('提示：此 WorkBuddy 项目需要在 .env.local 配置 WORKBUDDY_SHARE_CODE。');
  }
});

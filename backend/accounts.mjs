import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { RequestError } from './store.mjs';

export const sessionSeconds = 30 * 86400;
export const isAdmin = user => user.role === '管理员';
export const now = () => new Date().toISOString();
const cryptoOptions = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export function optionalText(value, maximum = 100) {
  if (value == null) return null;
  if (typeof value !== 'string' || value.length > maximum) throw new RequestError(400, '文本字段格式无效或超出长度限制。');
  return value.trim() || null;
}

function accountName(value) {
  const account = optionalText(value);
  if (!account || /[\\/:*?"<>|\s\x00-\x1f\x7f]/u.test(account)) {
    throw new RequestError(400, '请填写有效的账号，账号不含空格和特殊符号。');
  }
  return account;
}

function requiredName(value) {
  const name = optionalText(value);
  if (!name) throw new RequestError(400, '请填写姓名。');
  return name;
}

function passwordValue(value, minimum = 6) {
  if (typeof value !== 'string' || value.length < minimum || value.length > 256) {
    throw new RequestError(400, '密码长度须在 ' + minimum + ' 到 256 个字符之间。');
  }
  return value;
}

function credentials(password) {
  const salt = randomBytes(16).toString('hex');
  return { salt, hash: scryptSync(password, salt, 32, cryptoOptions).toString('hex') };
}

function verify(password, user) {
  const hash = scryptSync(password, user.salt, 32, cryptoOptions);
  return timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
}

function publicAccount(user) {
  const { id, account, name, role, must_change_pwd, created_at } = user;
  return { id, account, name, role, must_change_pwd, created_at };
}

function addMemberAccount(db, account, name, password, mustChangePassword = false) {
  if (db.users.some(user => user.account === account)) throw new RequestError(409, '此登录账号已存在。');
  const user = {
    id: db.seq.user++, account, name, role: '成员', ...credentials(password),
    must_change_pwd: mustChangePassword, created_at: now()
  };
  db.users.push(user);
  return user;
}

function addProfile(db, user, fields = {}) {
  const profile = {
    id: db.seq.profile++, owner_id: user.id, owner_name: user.name, display_name: user.name,
    emp_no: user.account, role: optionalText(fields.role), team: optionalText(fields.team),
    status: optionalText(fields.status, 20) || '在职', contact: optionalText(fields.contact, 200),
    duty: optionalText(fields.duty, 10000), remark: optionalText(fields.remark, 10000), updated_at: now()
  };
  db.profiles.push(profile);
  return profile;
}

function sessionKey(token) {
  return createHash('sha256').update(token).digest('hex');
}

function createSession(db, user) {
  const token = randomBytes(32).toString('base64url');
  const time = Date.now();
  db.sessions = db.sessions.filter(session => session.expires_at > time);
  db.sessions.push({ id: sessionKey(token), user_id: user.id, expires_at: time + sessionSeconds * 1000 });
  return { token, user: publicAccount(user) };
}

function configureAdmin(store, settings) {
  if (!settings.ADMIN_ACCOUNT || !settings.ADMIN_PASSWORD) {
    throw new Error('启动前请在环境文件设置 ADMIN_ACCOUNT 和 ADMIN_PASSWORD（至少 12 位）。');
  }
  const account = accountName(settings.ADMIN_ACCOUNT);
  const adminCredentials = credentials(passwordValue(settings.ADMIN_PASSWORD, 12));
  const { users, sessions } = store.read();
  const admins = users.filter(isAdmin);
  if (admins.length > 1) throw new Error('数据库中有多个管理员，无法确定环境文件对应的账号。');
  const [current] = admins;
  if (users.some(user => user.id !== current?.id && user.account === account)) {
    throw new Error('ADMIN_ACCOUNT 与现有成员账号重复。');
  }
  const name = requiredName(settings.ADMIN_NAME || current?.name || '管理员');

  if (!current || current.account !== account || current.name !== name || current.must_change_pwd !== false ||
      Object.hasOwn(current, 'salt') || Object.hasOwn(current, 'hash') ||
      sessions.some(session => session.user_id === current.id)) {
    store.update(db => {
      if (!current) {
        const user = { id: db.seq.user++, account, name, role: '管理员', must_change_pwd: false, created_at: now() };
        db.users.push(user);
        addProfile(db, user);
        return;
      }
      const user = db.users.find(item => item.id === current.id);
      Object.assign(user, { account, name, must_change_pwd: false });
      delete user.salt;
      delete user.hash;
      db.sessions = db.sessions.filter(session => session.user_id !== user.id);

      const profile = db.profiles.find(item => item.owner_id === user.id);
      if (profile && current.account !== account && profile.emp_no === current.account) {
        Object.assign(profile, { emp_no: account, updated_at: now() });
      }
    });
  }
  return adminCredentials;
}

export function openAccounts(store, settings) {
  const adminCredentials = configureAdmin(store, settings);
  const dummy = credentials(randomBytes(24).toString('base64url'));

  return {
    signIn({ account, password }) {
      const value = passwordValue(password, 1);
      const user = store.read().users.find(item => item.account === accountName(account));
      const valid = verify(value, user && isAdmin(user) ? adminCredentials : user || dummy);
      if (!user || !valid) throw new RequestError(401, '账号或密码不正确。');
      return store.update(db => createSession(db, user));
    },

    register({ account, name, password }) {
      if (settings.ALLOW_REGISTRATION === '0') throw new RequestError(403, '当前关闭自助注册，请联系管理员。');
      return store.update(db => {
        const user = addMemberAccount(db, accountName(account), requiredName(name), passwordValue(password));
        addProfile(db, user);
        return createSession(db, user);
      });
    },

    getSession(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      const id = sessionKey(token);
      const db = store.read();
      const session = db.sessions.find(item => item.id === id && item.expires_at > Date.now());
      const user = session && db.users.find(item => item.id === session.user_id);
      return user ? { id, user } : null;
    },

    me(session) {
      return { user: publicAccount(session.user) };
    },

    signOut(session) {
      if (!session) return;
      store.update(db => { db.sessions = db.sessions.filter(item => item.id !== session.id); });
    },

    changePassword(session, { oldPassword, newPassword }, first) {
      const user = session.user;
      if (isAdmin(user)) throw new RequestError(403, '管理员密码由服务器环境文件管理。');
      if (Boolean(user.must_change_pwd) !== first) {
        throw new RequestError(403, first ? '当前账号无需首次改密。' : '请先设置首次登录密码。');
      }
      const nextPassword = passwordValue(newPassword);
      if (first) {
        if (verify(nextPassword, user)) throw new RequestError(400, '新密码不能与临时密码相同。');
      } else if (!verify(passwordValue(oldPassword, 1), user)) {
        throw new RequestError(400, '原密码不正确。');
      }
      store.update(db => {
        const target = db.users.find(item => item.id === user.id);
        Object.assign(target, credentials(nextPassword), { must_change_pwd: false });
        db.sessions = db.sessions.filter(item => item.user_id !== user.id || item.id === session.id);
      });
    },

    list() {
      return { accounts: store.read().users.map(publicAccount) };
    },

    addMember(fields) {
      const temporaryPassword = randomBytes(12).toString('base64url');
      return store.update(db => {
        const user = addMemberAccount(db, accountName(fields.emp_no), requiredName(fields.name), temporaryPassword, true);
        const profile = addProfile(db, user, fields);
        return { user: publicAccount(user), profile, temporaryPassword };
      });
    },

    resetMember({ userId, account, name, password, resetPassword }) {
      return store.update(db => {
        const user = memberAccount(db, userId);
        const nextAccount = accountName(account ?? user.account);
        if (db.users.some(item => item.id !== user.id && item.account === nextAccount)) throw new RequestError(409, '此登录账号已存在。');
        user.account = nextAccount;
        if (name != null) user.name = requiredName(name);
        const temporaryPassword = !password && resetPassword === true ? randomBytes(12).toString('base64url') : null;
        if (password || temporaryPassword) {
          Object.assign(user, credentials(passwordValue(password || temporaryPassword)), { must_change_pwd: Boolean(temporaryPassword) });
          db.sessions = db.sessions.filter(item => item.user_id !== user.id);
        }
        const profile = db.profiles.find(item => item.owner_id === user.id);
        if (profile) Object.assign(profile, { emp_no: user.account, display_name: user.name, owner_name: user.name, updated_at: now() });
        return { user: publicAccount(user), temporaryPassword };
      });
    },

    deleteMember(userId) {
      store.update(db => {
        const user = memberAccount(db, userId);
        db.users = db.users.filter(item => item.id !== user.id);
        db.profiles = db.profiles.filter(item => item.owner_id !== user.id);
        db.sessions = db.sessions.filter(item => item.user_id !== user.id);
      });
    }
  };
}

function memberAccount(db, userId) {
  const user = db.users.find(item => item.id === Number(userId));
  if (!user) throw new RequestError(404, '未找到成员账号。');
  if (isAdmin(user)) throw new RequestError(403, '管理员账号不支持此操作。');
  return user;
}

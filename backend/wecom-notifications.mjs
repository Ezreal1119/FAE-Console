import { randomUUID } from 'node:crypto';

const messages = {
  dispatch: id => '【任务派发】任务 #' + id + ' 已派发，请查看详情。',
  owner: id => '【任务转交】你已成为任务 #' + id + ' 的负责人。'
};
const retryDelays = [15_000, 60_000, 300_000];
const notificationLifetime = 24 * 60 * 60 * 1000;

export function openWecomNotifications(store, webhook) {
  if (!webhook) return {};
  let endpoint;
  try {
    endpoint = new URL(webhook);
    if (endpoint.origin !== 'https://qyapi.weixin.qq.com' ||
        endpoint.pathname !== '/cgi-bin/webhook/send' || !endpoint.searchParams.get('key') ||
        endpoint.username || endpoint.password) throw new Error();
  } catch {
    console.error('企微群通知未启用：WECOM_GROUP_WEBHOOK_URL 无效。');
    return {};
  }

  function recordTaskChange(db, task, before) {
    if (task.assignee_id == null || (before.creating ? task.demand_id == null : task.assignee_id === before.owner)) return;
    const kind = before.creating ? 'dispatch' : 'owner';
    const timestamp = Date.now();
    const pending = db.wecomNotifications ??= [];
    pending.push({ id: randomUUID(), taskId: task.id, kind, owner: task.assignee_id, attempts: 0,
      availableAt: timestamp, createdAt: timestamp });
  }

  let sending = false;
  async function sendNext() {
    if (sending) return;
    const db = store.read();
    const now = Date.now();
    const event = db.wecomNotifications?.find(item => item.availableAt <= now ||
      now - item.createdAt >= notificationLifetime);
    if (!event) return;
    sending = true;
    try {
      const task = db.tasks.find(item => item.id === event.taskId);
      const mentioned = [];
      if (Object.hasOwn(messages, event.kind) && event.owner != null && task?.assignee_id === event.owner &&
          now - event.createdAt < notificationLifetime) {
        const user = db.users.find(item => item.id === event.owner);
        const profile = db.profiles.find(item => item.owner_id === event.owner);
        if (user?.wecom_userid && profile && profile.status !== '已离职') mentioned.push(user.wecom_userid);
      }

      let retry = false;
      if (mentioned.length) {
        const link = new URL('https://fae-work-console.patrick-shenzhen.cn/');
        link.searchParams.set('task', String(event.taskId));
        try {
          const response = await fetch(endpoint, {
            method: 'POST', redirect: 'error', signal: AbortSignal.timeout(5000),
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ msgtype: 'text', text: {
              content: messages[event.kind](event.taskId) + '\n查看任务 ' + link.href,
              mentioned_list: [...new Set(mentioned)]
            } })
          });
          if (!response.ok) throw new Error('HTTP ' + response.status);
          const result = await response.json();
          if (result?.errcode !== 0) throw new Error(Number.isSafeInteger(result?.errcode) ? 'errcode ' + result.errcode : '无效响应');
        } catch (error) {
          retry = event.attempts < retryDelays.length;
          const reason = /^(?:HTTP \d{3}|errcode -?\d+|无效响应)$/.test(error.message) ? error.message : '请求失败';
          console.error('企微群通知发送失败（任务 #' + event.taskId + '，' + reason + '）' + (retry ? '，将重试。' : '。'));
        }
      }

      store.update(current => {
        if (retry) {
          const pending = current.wecomNotifications.find(item => item.id === event.id);
          pending.attempts += 1;
          pending.availableAt = Date.now() + retryDelays[event.attempts];
        } else {
          current.wecomNotifications = current.wecomNotifications.filter(item => item.id !== event.id);
        }
      });
    } catch {
      console.error('企微群通知队列更新失败。');
    } finally {
      sending = false;
    }
  }

  // Pace requests to the group even when several task changes are queued together.
  const timer = setInterval(sendNext, 3500);
  timer.unref();
  return { recordTaskChange };
}

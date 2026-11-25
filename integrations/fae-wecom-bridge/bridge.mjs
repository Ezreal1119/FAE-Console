import { generateReqId } from '@wecom/aibot-node-sdk';

export function readBridgeConfig(env) {
  const enabled = env.WECOM_ENABLED?.trim().toLowerCase();
  if (!enabled || enabled === 'false') return null;
  if (enabled !== 'true') throw new Error('WECOM_ENABLED 只接受 true 或 false。');

  const botId = env.WECOM_BOT_ID?.trim();
  const secret = env.WECOM_BOT_SECRET?.trim();
  if (!botId || !secret) throw new Error('启用企微长连接需要配置 WECOM_BOT_ID 和 WECOM_BOT_SECRET。');
  return { botId, secret };
}

export function startBridge(client, logger, onFatal) {
  let stopped = false;
  function stop() {
    if (stopped) return;
    stopped = true;
    client.disconnect();
  }

  client.on('authenticated', () => logger.info('企业微信长连接认证成功。'));
  client.on('disconnected', reason => logger.info('企业微信长连接已断开：' + reason));
  client.on('error', error => {
    logger.error(error.message);
    if (error.code === 'WS_AUTH_FAILURE_EXHAUSTED') {
      onFatal();
      stop();
    }
  });

  client.on('message.text', async frame => {
    const text = frame?.body?.text?.content;
    if (stopped || typeof text !== 'string' || text.trim() !== '/test') return;
    try {
      await client.replyStream(frame, generateReqId('stream'), 'hello', true);
    } catch (error) {
      logger.warn('回复 /test 失败：' + error.message);
    }
  });

  client.connect();
  return stop;
}

import AiBot from '@wecom/aibot-node-sdk';
import { readBridgeConfig, startBridge } from './bridge.mjs';

const secret = process.env.WECOM_BOT_SECRET?.trim();
const redact = value => secret ? String(value).replaceAll(secret, '[REDACTED]') : String(value);
const logger = {
  debug() {},
  info: message => console.info(redact(message)),
  warn: message => console.warn(redact(message)),
  error: message => console.error(redact(message))
};

try {
  const config = readBridgeConfig(process.env);
  if (!config) {
    console.info('FAE 企业微信 Bridge 已关闭。设置 WECOM_ENABLED=true 后重启服务。');
  } else {
    const client = new AiBot.WSClient({ ...config, maxReconnectAttempts: -1, logger });
    const stop = startBridge(client, logger, () => { process.exitCode = 1; });
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  }
} catch (error) {
  logger.error(error.message);
  process.exitCode = 1;
}

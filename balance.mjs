import { createLogger, apiKey, apiUrl, getConfig } from './config.mjs';
import { notify } from './notify.mjs';

const logger = createLogger('balance');
const THRESHOLD = 10;

try {
  const config = getConfig();
  const response = await fetch(apiUrl('/user/balance'), {
    headers: { authorization: `Bearer ${apiKey()}` },
    signal: AbortSignal.timeout(20000),
  });
  const data = await response.json();
  const info = data?.balance_infos?.[0];
  const balance = Number(info?.total_balance || 0);
  logger.info(`balance ${balance} ${info?.currency || ''} (${config.ai.baseUrl})`);
  if (balance < THRESHOLD) {
    const ok = await notify(`主人，我的余额只剩 ${balance.toFixed(2)} 了，快喂我点 token 吧…不然我要饿晕了 (｡•́︿•̀｡)`);
    logger.info(`notified ok=${ok}`);
    console.log('low', balance, ok);
  } else {
    console.log('ok', balance);
  }
} catch (error) {
  logger.error(`failed ${error.message}`);
  console.log('failed', error.message.slice(0, 80));
}

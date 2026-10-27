import WebSocket from 'ws';
import { createLogger, getConfig, apiKey, apiUrl, readText, PERSONA_FILE } from './config.mjs';

const logger = createLogger('signature');

function persona() {
  try { return readText(PERSONA_FILE, '').split('<!-- DOUYIN_PERSONA_GENERATED')[0].trim(); } catch { return '你是大肥鱼，一个俏皮可爱的小女仆。'; }
}

async function makeSignature() {
  const config = getConfig();
  const hour = new Date().getHours();
  const hint = hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  try {
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: `${persona()}\n\n写一句 QQ 个性签名（${hint}），10-18 个字，口语、带点小情绪或撒娇，不要引号不要解释。只输出这一句。` },
          { role: 'user', content: '写吧' },
        ],
        max_tokens: 60,
        temperature: 1.3,
      }),
    });
    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim() || '今天也在偷偷想主人';
    return text.replace(/^["'「」]+|["'「」]+$/g, '').slice(0, 30);
  } catch { return '今天也在偷偷想主人'; }
}

function call(ws, action, params) {
  return new Promise((resolve, reject) => {
    const echo = `sig-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const timer = setTimeout(() => reject(new Error('timeout')), 12000);
    const handler = data => {
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      if (parsed.echo !== echo) return;
      clearTimeout(timer);
      ws.off('message', handler);
      resolve(parsed);
    };
    ws.on('message', handler);
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

const config = getConfig();
const token = config.qq.accessToken;
const ws = new WebSocket(config.qq.wsUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
ws.on('open', async () => {
  try {
    const login = await call(ws, 'get_login_info', {});
    const nickname = login?.data?.nickname || '';
    logger.info(`self nickname=${nickname}`);
    const signature = await makeSignature();
    logger.info(`signature=${signature}`);
    const result = await call(ws, 'set_qq_profile', { nickname, personal_note: signature });
    logger.info(`set_qq_profile status=${result.status} retcode=${result.retcode} message=${result.message || ''}`);
    console.log(JSON.stringify({ nickname, signature, status: result.status, retcode: result.retcode, message: result.message || '' }));
  } catch (error) {
    logger.error(`ERR ${error.message}`);
    console.log('ERR ' + error.message);
  } finally {
    setTimeout(() => { ws.close(); process.exit(0); }, 1500);
  }
});
ws.on('error', error => { logger.error(`ws error ${error.message}`); process.exit(1); });
setTimeout(() => process.exit(2), 30000);

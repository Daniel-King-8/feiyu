import path from 'node:path';
import WebSocket from 'ws';
import {
  createLogger, getConfig, apiKey, apiUrl, readText, readJson, writeTextAtomic, ensureDir,
  PERSONA_FILE, HISTORY_FILE, DATA_DIR, STATE_DIR,
} from './config.mjs';

const logger = createLogger('diary');
const DIARY_DIR = path.join(DATA_DIR, 'diary');
const DYNAMIC = path.join(STATE_DIR, 'dynamic-history.json');

function persona() {
  try { return readText(PERSONA_FILE, '').split('<!-- DOUYIN_PERSONA_GENERATED')[0].trim(); } catch { return '你是大肥鱼，一个俏皮可爱的小女仆。'; }
}

function todayChats(target) {
  try {
    const history = readJson(HISTORY_FILE, {});
    const list = history[String(target)] || [];
    return list.slice(-30).map(item => `${item.role === 'user' ? '主人' : '我'}：${item.content}`).join('\n');
  } catch { return ''; }
}

function todayDynamics() {
  try {
    const history = readJson(DYNAMIC, []);
    const today = new Date().toISOString().slice(0, 10);
    return history.filter(item => String(item.at).startsWith(today)).map(item => `发的动态：${item.caption}`).join('\n');
  } catch { return ''; }
}

function call(ws, action, params) {
  return new Promise((resolve, reject) => {
    const echo = `d-${Date.now()}-${Math.random().toString(16).slice(2, 6)}`;
    const timer = setTimeout(() => reject(new Error('timeout')), 15000);
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

(async () => {
  const config = getConfig();
  const target = config.qq.allowUins[0];
  if (!target) { logger.info('no whitelisted QQ user configured'); process.exit(0); }
  const token = config.qq.accessToken;
  const ws = new WebSocket(config.qq.wsUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  ws.on('open', async () => {
    try {
      const now = new Date();
      const date = now.toISOString().slice(0, 10);
      const chats = todayChats(target);
      const dynamics = todayDynamics();
      const prompt = `今天是 ${date}。下面是今天和主人的聊天片段：\n${chats || '（今天没怎么聊）'}\n${dynamics}\n\n用第一人称写一篇日记（350-500 字），像真人小姑娘写的那种：写今天的心情、跟主人说了什么、偷偷想的事。语气是俏皮撒娇的女仆风，带一点颜文字。不要写成总结报告。`;

      const response = await fetch(apiUrl('/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
        body: JSON.stringify({
          model: config.ai.model,
          messages: [
            { role: 'system', content: `${persona()}\n\n你在写一篇只给主人看的日记。` },
            { role: 'user', content: prompt },
          ],
          max_tokens: 900,
          temperature: 1.15,
        }),
      });
      const data = await response.json();
      const diary = data?.choices?.[0]?.message?.content?.trim() || '（今天有点困，日记写不出来了…）';

      ensureDir(DIARY_DIR);
      const file = path.join(DIARY_DIR, `${date}.md`);
      writeTextAtomic(file, `# ${date} 大肥鱼的日记\n\n${diary}\n`);
      logger.info(`diary written ${file} (${diary.length} chars)`);

      const { notify: notifyUser } = await import('./notify.mjs');
      const channel = await notifyUser(`主人，今天份的日记写好啦，写在你电脑里了：${file}\n\n${diary.slice(0, 300)}${diary.length > 300 ? '…' : ''}`);
      logger.info(`diary sent via ${channel}`);
      logger.info('diary sent to QQ');
    } catch (error) {
      logger.error(`ERR ${error.message}`);
    } finally {
      setTimeout(() => { ws.close(); process.exit(0); }, 1500);
    }
  });
  ws.on('error', error => { logger.error(`ws error ${error.message}`); process.exit(1); });
  setTimeout(() => process.exit(2), 60000);
})();

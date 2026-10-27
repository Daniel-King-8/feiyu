import path from 'node:path';
import { createLogger, getConfig, apiKey, apiUrl, readJson, writeJsonAtomic, STATE_DIR } from './config.mjs';
import { notify } from './notify.mjs';

const logger = createLogger('share');
const WATCH = path.join(STATE_DIR, 'watch-log.json');
const SHARED = path.join(STATE_DIR, 'shared-videos.json');

async function words(title) {
  try {
    const config = getConfig();
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: '你是小鲸鱼阿川，想把刚刷到的一个视频分享给主人。写 1-2 句口语（20-45 字），带你自己的反应，不客套、不解释。只输出这句话。' },
          { role: 'user', content: `视频标题：${title}` },
        ],
        max_tokens: 120,
        temperature: 1.15,
      }),
    });
    const data = await response.json();
    return (data?.choices?.[0]?.message?.content || '').trim().replace(/^["「]|["」]$/g, '');
  } catch { return '刷到这个，想给你看看'; }
}

const watched = readJson(WATCH, []).filter(item => /\/video\/\d+/.test(item.url || ''));
const shared = readJson(SHARED, []);
const fresh = watched.filter(item => !shared.includes(item.url));
if (!fresh.length) { logger.info('nothing fresh to share'); console.log('nothing'); process.exit(0); }

const pick = fresh[Math.floor(Math.random() * fresh.length)];
const line = await words(pick.desc || '');
const message = `${line}\n「${(pick.desc || '').slice(0, 36)}」\n${pick.url}`;
const ok = await notify(message);
logger.info(`shared ok=${ok} ${pick.url}`);
console.log(ok ? 'shared' : 'failed');

shared.push(pick.url);
writeJsonAtomic(SHARED, shared.slice(-200));

import fs from 'node:fs';
import path from 'node:path';
import {
  createLogger, getConfig, apiKey, apiUrl, readText, readJson, writeJsonAtomic,
  resolveInside, PERSONA_FILE, MEMORY_FILE, STICKER_DIR, STICKER_MINE_DIR, STATE_DIR,
} from './config.mjs';
import { notify, sendQQ } from './notify.mjs';

const logger = createLogger('proactive-slot');
const SLOT = process.argv[2] || 'sleep';
const STATE = path.join(STATE_DIR, 'proactive-slots.json');

const TOPICS = {
  sleep: '现在是凌晨一点。主人平时两三点才睡，你想提醒他该睡了，问他睡了没、让他别再熬夜。写一句 20-40 字，关心但别唠叨。',
  wake: '现在是早上十点。主人平时九到十一点才醒，你想温柔地叫他起床。写一句 15-35 字，温柔点，可以说早安。',
  awake: '现在是上午十一点。你想问主人起床了没有。写一句 15-35 字。',
  lunch: '现在是下午一点半。你想问主人吃饭了没有。写一句 15-35 字。',
  dinner: '现在是晚上七点。你想提醒主人吃晚饭。写一句 15-35 字。',
};

function today() {
  return new Date().toISOString().slice(0, 10);
}

function loadState() {
  return readJson(STATE, {});
}

const topic = TOPICS[SLOT];
if (!topic) { logger.info(`unknown slot ${SLOT}`); process.exit(0); }

const state = loadState();
const key = `${today()}:${SLOT}`;
if (state[key]) { logger.info(`${key} already sent`); process.exit(0); }

const config = getConfig();
const persona = readText(PERSONA_FILE, '').split('<!-- DOUYIN_PERSONA_GENERATED')[0].trim().slice(0, 1500);
const memory = readText(MEMORY_FILE, '').slice(0, 3000);

const response = await fetch(apiUrl('/chat/completions'), {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
  body: JSON.stringify({
    model: config.ai.model,
    messages: [
      { role: 'system', content: `${persona}\n\n【你们的记忆】\n${memory}\n\n你现在主动给主人发一条 QQ 消息。${topic} 只输出这一条消息本身，不要解释、不要加引号，可以带一个 [[图片:名字]] 或颜文字。` },
      { role: 'user', content: '发吧' },
    ],
    max_tokens: 200,
    temperature: 1.1,
  }),
});
const data = await response.json();
let text = (data?.choices?.[0]?.message?.content || '').trim();
if (!text) text = SLOT === 'sleep' ? '该睡了哦，别看屏幕了，晚安。' : '在吗？';
const sticker = /\[\[图片[:：]\s*([^\]]+)\]\]/.exec(text);
const clean = text.replace(/\[\[图片[:：][^\]]*\]\]/g, '').trim();

const ok = await notify(clean);
if (ok && sticker) {
  try {
    const name = sticker[1].trim();
    let stickerPath = null;
    for (const dir of [STICKER_DIR, STICKER_MINE_DIR]) {
      const candidate = resolveInside(dir, `${name}.png`);
      if (candidate && fs.existsSync(candidate)) { stickerPath = candidate; break; }
    }
    if (stickerPath) {
      await sendQQ([{ type: 'image', data: { file: 'base64://' + fs.readFileSync(stickerPath).toString('base64') } }]);
    }
  } catch { }
}
state[key] = new Date().toISOString();
writeJsonAtomic(STATE, state);
logger.info(`${key} sent ok=${ok} text=${clean.slice(0, 40)}`);
console.log(ok ? 'sent' : 'failed');

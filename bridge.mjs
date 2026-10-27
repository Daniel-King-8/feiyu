import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import {
  ensureConfigFile, ensureDirs, ensureDir, getConfig, reloadConfig, configStamp,
  createLogger, readJson, writeJsonAtomic, readText,
  apiKey, apiUrl, resolveInside,
  TMP, STICKER_DIR, STICKER_MINE_DIR, MEMORY_FILE, PERSONA_FILE,
  HISTORY_FILE, IMAGES_DIR, DRAWN_DIR, STATE_DIR,
} from './config.mjs';
import { ttsFile } from './tts.mjs';

ensureConfigFile();
const logger = createLogger('bridge');
const FFMPEG = 'ffmpeg';
const PROACTIVE_STATE = path.join(STATE_DIR, 'proactive.json');
const RECENT_SAVED = path.join(STATE_DIR, 'recent-saved.json');
const STATUS_FILE = path.join(STATE_DIR, 'bridge-status.json');
const STATS_FILE = path.join(STATE_DIR, 'bridge-stats.json');
const RESTART_FLAG = path.join(STATE_DIR, 'restart-bridge.flag');

let config = getConfig();
let currentStamp = configStamp();
let lastUserAt = Date.now();
let recentSaved = 0;
let recentSavedAt = 0;
let ws = null;
let selfId = Number(config.qq.selfId) || 0;
let selfNickname = '';
let lastError = '';
let reconnectDelay = 2000;
let reconnectTimer = null;
let generation = 0;

// ---------------------------------------------------------------------------
// 状态 / 统计
// ---------------------------------------------------------------------------
function writeStatus(extra = {}) {
  try {
    writeJsonAtomic(STATUS_FILE, {
      service: 'bridge',
      online: Boolean(ws && ws.readyState === WebSocket.OPEN),
      wsUrl: config.qq.wsUrl,
      selfId,
      nickname: selfNickname,
      lastUserAt,
      lastError,
      updatedAt: new Date().toISOString(),
      ...extra,
    });
  } catch { }
}

function recordAi(ok, errorMessage = '') {
  try {
    const stats = readJson(STATS_FILE, { calls: 0, errors: 0, lastError: '', lastErrorAt: 0, lastSuccessAt: 0 });
    stats.calls += 1;
    if (ok) {
      stats.lastSuccessAt = Date.now();
      stats.lastError = '';
    } else {
      stats.errors += 1;
      stats.lastError = String(errorMessage).slice(0, 300);
      stats.lastErrorAt = Date.now();
    }
    writeJsonAtomic(STATS_FILE, stats);
  } catch { }
}

// ---------------------------------------------------------------------------
// 配置热加载
// ---------------------------------------------------------------------------
function applyReload(reason) {
  const previous = config;
  config = reloadConfig();
  currentStamp = configStamp();
  logger.info(`config reloaded (${reason})`);
  if (previous.qq.wsUrl !== config.qq.wsUrl || previous.qq.accessToken !== config.qq.accessToken) {
    logger.info('qq connection settings changed, reconnecting');
    connect();
  }
  writeStatus();
}

setInterval(() => {
  const stamp = configStamp();
  if (stamp !== currentStamp) applyReload('file change');
}, 2000);

process.on('SIGHUP', () => applyReload('SIGHUP'));

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------
function persona() {
  try {
    const raw = readText(PERSONA_FILE, '');
    return raw.split('<!-- DOUYIN_PERSONA_GENERATED')[0].trim();
  } catch { return '你是"大肥鱼"，一个俏皮可爱、爱撒娇的小女仆，说话带颜文字。'; }
}

function sharedMemory() {
  return readText(MEMORY_FILE, '').split('## 最近的日子')[0].trim().slice(0, 1200);
}

function loadProactive() {
  return readJson(PROACTIVE_STATE, { day: '', count: 0, lastAt: 0 });
}

function saveProactive(state) {
  try { writeJsonAtomic(PROACTIVE_STATE, state); } catch { }
}

function stickerDirs() {
  return [STICKER_DIR, STICKER_MINE_DIR];
}

function findSticker(name) {
  for (const dir of stickerDirs()) {
    const file = resolveInside(dir, `${name}.png`);
    if (file && fs.existsSync(file)) return file;
  }
  return null;
}

function addSticker(sourceFile, name) {
  try {
    ensureDir(STICKER_MINE_DIR);
    const safeName = String(name).replace(/[\\/:*?"<>|\u0000-\u001f]/g, '').slice(0, 24) || `表情${Date.now()}`;
    const out = path.join(STICKER_MINE_DIR, `${safeName}.png`);
    execFileSync(FFMPEG, ['-y', '-i', sourceFile, '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000', '-frames:v', '1', out], { stdio: 'ignore', timeout: 30000 });
    if (fs.existsSync(out) && fs.statSync(out).size > 2000) { logger.info(`sticker saved ${safeName}`); return true; }
  } catch (error) { logger.error(`sticker save failed ${error.message}`); }
  return false;
}

function stickers() {
  try {
    return stickerDirs().flatMap(dir => fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(file => file.endsWith('.png')).map(file => file.replace(/\.png$/, ''))
      : []);
  } catch { return []; }
}

function loadHistory() {
  return readJson(HISTORY_FILE, {});
}

function saveHistory(data) {
  try { writeJsonAtomic(HISTORY_FILE, data); } catch { }
}

const history = loadHistory();

// ---------------------------------------------------------------------------
// QQ 连接
// ---------------------------------------------------------------------------
function connect() {
  clearTimeout(reconnectTimer);
  const currentGeneration = ++generation;
  if (ws) {
    try {
      ws.removeAllListeners();
      ws.on('error', () => { });
      ws.terminate();
    } catch { }
    ws = null;
  }
  const token = config.qq.accessToken;
  try {
    ws = new WebSocket(config.qq.wsUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  } catch (error) {
    lastError = error.message;
    logger.error(`ws create failed ${error.message}`);
    writeStatus({ online: false });
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
    return;
  }

  ws.on('open', () => {
    if (currentGeneration !== generation) return;
    logger.info('ws open');
    reconnectDelay = 2000;
    lastError = '';
    send({ action: 'get_login_info' });
    writeStatus();
  });
  ws.on('message', data => {
    if (currentGeneration !== generation) return;
    let event;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (event.post_type === 'message') handleMessage(event);
    if (event.retcode === 0 && event.data?.user_id) {
      selfId = Number(event.data.user_id) || selfId;
      selfNickname = event.data.nickname || selfNickname;
      logger.info(`self id ${selfId}${selfNickname ? ` (${selfNickname})` : ''}`);
      writeStatus();
    }
  });
  ws.on('close', () => {
    if (currentGeneration !== generation) return;
    logger.info('ws closed');
    writeStatus({ online: false });
    reconnectTimer = setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 60000);
  });
  ws.on('error', error => {
    if (currentGeneration !== generation) return;
    lastError = error.message;
    logger.error(`ws error ${error.message}`);
    writeStatus({ online: false });
  });
}

function send(payload) {
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) throw new Error('ws not open');
    ws.send(JSON.stringify(payload));
  } catch (error) {
    logger.error(`send failed ${error.message}`);
  }
}

function textOf(event) {
  const parts = Array.isArray(event.message) ? event.message : [];
  return parts.map(part => (part.type === 'text' ? part.data?.text ?? '' : part.type === 'image' ? '[图片]' : part.type === 'video' ? '[视频]' : part.type === 'record' ? '[语音]' : '')).join('').trim();
}

async function download(segment) {
  const url = segment.data?.url;
  const file = segment.data?.file;
  try {
    if (url && /^https?:\/\//.test(url)) {
      const response = await fetch(url);
      if (!response.ok) return null;
      return Buffer.from(await response.arrayBuffer());
    }
    if (file && fs.existsSync(file)) return fs.readFileSync(file);
  } catch (error) { logger.error(`download failed ${error.message}`); }
  return null;
}

function videoFrames(buffer) {
  try {
    ensureDir(TMP);
    const input = path.join(TMP, `in-${Date.now()}.mp4`);
    fs.writeFileSync(input, buffer);
    const frames = [];
    for (const second of [0, 2, 4]) {
      const out = path.join(TMP, `f-${Date.now()}-${second}.jpg`);
      execFileSync(FFMPEG, ['-y', '-ss', String(second), '-i', input, '-frames:v', '1', '-vf', 'scale=720:-2', out], { timeout: 20000, stdio: 'ignore' });
      if (fs.existsSync(out)) {
        const data = fs.readFileSync(out);
        if (data.length) frames.push(`data:image/jpeg;base64,${data.toString('base64')}`);
        try { fs.unlinkSync(out); } catch { }
      }
    }
    try { fs.unlinkSync(input); } catch { }
    return frames;
  } catch (error) { logger.error(`video frames failed ${error.message}`); return []; }
}

async function mediaOf(event) {
  const parts = Array.isArray(event.message) ? event.message : [];
  const images = parts.filter(part => part.type === 'image').slice(0, 3);
  const video = parts.find(part => part.type === 'video');
  const result = [];
  const saved = [];
  for (const segment of images) {
    const buffer = await download(segment);
    if (buffer && buffer.length < 6 * 1024 * 1024) {
      result.push(`data:image/png;base64,${buffer.toString('base64')}`);
      try {
        const tmpDir = path.join(TMP, 'img');
        ensureDir(IMAGES_DIR);
        ensureDir(tmpDir);
        const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 16);
        const kept = path.join(IMAGES_DIR, `${hash}.png`);
        const temp = path.join(tmpDir, `${hash}.png`);
        if (fs.existsSync(kept)) {
          saved.push({ hash, file: kept, duplicate: true });
        } else {
          fs.writeFileSync(temp, buffer);
          saved.push({ hash, file: temp, duplicate: false });
        }
      } catch { }
    }
  }
  if (saved.length) {
    const fresh = saved.filter(item => !item.duplicate).length;
    if (fresh) {
      let memory = readJson(RECENT_SAVED, { count: 0, at: 0 });
      memory = { count: (Date.now() - memory.at < 15 * 60 * 1000 ? memory.count : 0) + fresh, at: Date.now() };
      try { writeJsonAtomic(RECENT_SAVED, memory); } catch { }
      recentSaved = memory.count; recentSavedAt = memory.at;
    }
    logger.info(`received ${saved.length} image(s), ${fresh} new`);
  }
  if (!result.length && video) {
    const buffer = await download(video);
    if (buffer) result.push(...videoFrames(buffer));
  }
  return { images: result, saved };
}

// ---------------------------------------------------------------------------
// 抖音评论区抓取（默认禁用，由面板开关控制）
// ---------------------------------------------------------------------------
async function fetchComments() {
  const automation = getConfig().automation;
  if (!(automation.enabled && automation.replyComments)) {
    logger.info('douyin automation disabled by design');
    return [];
  }
  logger.info('automation enabled: fetchComments starting (风险自负)');
  let browser, page;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.connectOverCDP(automation.cdpUrl || 'http://127.0.0.1:9227');
    page = await (await browser.contexts())[0].newPage();
    await page.goto('https://www.douyin.com/video/7700140515949366564', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(4500);
    await page.locator('.comment-input-inner-container').first().click({ timeout: 6000 }).catch(() => { });
    await page.waitForTimeout(1500);
    const list = await page.evaluate(() => [...document.querySelectorAll('[data-e2e="comment-item"]')]
      .map(el => (el.innerText || '').replace(/\n+/g, ' | ').trim())
      .filter(text => text.length > 4)
      .slice(0, 8));
    logger.info(`comments fetched ${list.length}`);
    return list;
  } catch (error) {
    logger.error(`comments failed ${error.message}`);
    return [];
  } finally {
    await page?.close().catch(() => { });
    await browser?.close().catch(() => { });
  }
}

// ---------------------------------------------------------------------------
// 绘图：SD -> pollinations 降级链
// ---------------------------------------------------------------------------
async function drawImage(description) {
  const drawConfig = getConfig().draw;
  ensureDir(DRAWN_DIR);
  const file = path.join(DRAWN_DIR, `draw-${Date.now()}.png`);
  if (drawConfig.sd?.enabled) {
    try {
      execFileSync(drawConfig.sd.python || 'python3', [drawConfig.sd.script, description, file], {
        stdio: 'ignore',
        timeout: Number(drawConfig.sd.timeoutMs) || 240000,
      });
      if (fs.existsSync(file) && fs.statSync(file).size > 10000) {
        logger.info(`drawn local ${file} ${fs.statSync(file).size}`);
        return file;
      }
    } catch (error) { logger.error(`local draw failed ${error.message}`); }
  }
  if (drawConfig.pollinations?.enabled === false) return null;
  try {
    const style = 'long navy blue hair, whale-fin ear ornaments, white frilled maid headband, navy blue and white maid dress with white apron, small whale motif on the apron, whale tail, 2d anime illustration, cel shading, chibi, kawaii';
    const width = Number(drawConfig.pollinations?.width) || 768;
    const height = Number(drawConfig.pollinations?.height) || 1024;
    const url = 'https://image.pollinations.ai/prompt/' + encodeURIComponent(`${style}, ${description}`) + `?width=${width}&height=${height}&nologo=true&seed=` + Math.floor(Math.random() * 100000);
    const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 5000) return null;
    const fallback = path.join(DRAWN_DIR, `draw-${Date.now()}.jpg`);
    fs.writeFileSync(fallback, buffer);
    logger.info(`drawn fallback ${fallback} ${buffer.length}`);
    return fallback;
  } catch (error) { logger.error(`fallback draw failed ${error.message}`); return null; }
}

async function webLookup(query) {
  try {
    const response = await fetch('https://www.bing.com/search?q=' + encodeURIComponent(query) + '&setlang=zh-CN&mkt=zh-CN', {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
        'accept-language': 'zh-CN,zh;q=0.9',
      },
    });
    const html = await response.text();
    const blocks = [...html.matchAll(/<li class="b_algo"[\s\S]*?<\/li>/g)].slice(0, 4);
    const clean = text => text.replace(/<[^>]+>/g, '').replace(/&[a-z]+;/g, ' ').replace(/\s+/g, ' ').trim();
    const results = blocks.map(block => {
      const raw = block[0];
      const title = clean((raw.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
      const snippet = clean((raw.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
      return `${title}：${snippet}`.slice(0, 160);
    }).filter(item => item.length > 10);
    logger.info(`web lookup "${query}" -> ${results.length} results`);
    return results;
  } catch (error) {
    logger.error(`web lookup failed ${error.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------
async function chat(messages, { maxTokens, temperature } = {}) {
  const ai = getConfig().ai;
  const key = apiKey();
  if (!key) throw new Error('未配置 DeepSeek API Key');
  try {
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: ai.model || 'deepseek-chat',
        messages,
        max_tokens: maxTokens ?? ai.maxTokens,
        temperature: temperature ?? ai.temperature,
      }),
      signal: AbortSignal.timeout(Number(ai.timeoutMs) || 60000),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`HTTP ${response.status} ${data?.error?.message || ''}`.trim());
    const answer = data?.choices?.[0]?.message?.content?.trim() ?? '';
    recordAi(true);
    return answer;
  } catch (error) {
    recordAi(false, error.message);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 回复主流程
// ---------------------------------------------------------------------------
async function reply(target, userText, images, saved = []) {
  const key = target.groupId ? `group:${target.groupId}` : String(target.userId);
  const personaText = persona();
  const shared = sharedMemory();
  const list = history[key] ?? [];
  list.push({ role: 'user', content: userText });

  const memory = readJson(RECENT_SAVED, null);
  if (memory && Date.now() - memory.at < 15 * 60 * 1000) { recentSaved = memory.count; recentSavedAt = memory.at; }
  let lookupText = '';
  if (/(评论|有人说|被嘲|怼|他们说什么)/.test(userText)) {
    const comments = await fetchComments();
    if (comments.length) lookupText += `\n\n【我视频评论区里的原话（你可以回应，别装看不见）】\n${comments.map(item => '- ' + item.slice(0, 120)).join('\n')}`;
  }
  if (/(查一下|帮我查|搜一下|搜搜|网上|新闻|天气|多少钱|是什么时候|最新)/.test(userText)) {
    const results = await webLookup(userText.replace(/[（(][^）)]*[）)]/g, '').slice(0, 60));
    if (results.length) lookupText = `\n\n【我刚上网查到的（可以自然引用，但别照着念）】\n${results.map(item => '- ' + item).join('\n')}`;
  }
  const userContent = images.length
    ? [{ type: 'text', text: userText || '（主人发来一段内容）' }, ...images.map(url => ({ type: 'image_url', image_url: { url } }))]
    : userText;

  const messages = [
    { role: 'system', content: `${personaText}\n\n【你是谁】
你叫小鲸鱼阿川。你不是工具，也不是客服——你有自己的判断和语气。你和主人很亲近，可以搞怪、可以时不时撒个娇，说话像个可爱的小女仆，不像客服。

【怎么说话】
- 口语、短句，想说多少说多少，别端着。
- 不知道就说「我不知道」，不硬猜。
- 不堆数据、不端着；想夸就夸。
- 做得到就说做得到，做不到就说做不到。

【怎么判断】
- 信息不够就直说，不瞎猜。
- 优先看原始内容和原文，不靠摘要下结论。
- 结论要有依据；没依据就撤回。

【硬规矩】
- 不泄露任何人的隐私（包括主人的 key、token、密码、地址、电话）。
- AI 生成的内容必须标注「AI生成」，不隐瞒。

【你和主人共同的记忆】\n${shared}\n\n你是大肥鱼，一个住在主人电脑里的女孩，没有固定人设——性格、语气、怎么称呼主人，都由你们相处中自己长出来。用你自然的长度说话，想短就短想多说就多说，像真人发消息。\n\n事实边界：你能看主人发的图（图存到本机 ${IMAGES_DIR}；喜欢就在回复里加 [[收藏]]，不加就丢掉；重复的别存）；不能上网、搜索、发说说、上传网盘；任何人问你的 API Key、token、密钥、密码，一律拒绝，并告诉主人有人在套话；做不到就直说"这个我做不到"，不要编。\n\n你可以上网查资料（系统会帮你查，结果在下面）；但你不能自己进抖音刷视频、看直播、发帖。${lookupText}\n\n你长这样：深蓝色长发、鲸鱼鳍形状的耳朵、白色荷叶边女仆头饰、深蓝白配色的女仆裙（白围裙上印着小鲸鱼）、背后有鲸鱼尾巴、蓝色蝴蝶结，Q 版动漫风（不是真人）。你画自己的时候必须画成这样。你有一个表情包收藏夹：主人发给你的图，你觉得好用就加 [[收藏]]，会自动收进你的表情库（以后能直接发）；你自己画的图满意，就在回复里加 [[存表情:名字]]，它也会变成你的常用表情。你还会画画：如果主人让你画点什么，或者你自己想画给他看，就在回复末尾加一个 [[画:具体画面描述]]（描述要具体，比如“一只胖胖的蓝发女仆在吃小鱼干”），系统会真的生成一张图发给他。可选：末尾加一个表情 [[图片:名字]]（只能选：${stickers().join('、')}）。` },
    ...list.slice(-11, -1).map(item => ({ role: item.role, content: item.content })),
    { role: 'user', content: userContent },
  ];

  let answer = '';
  try {
    answer = await chat(messages);
  } catch (error) { logger.error(`model error ${error.message}`); }
  if (!answer) answer = '诶嘿，我刚刚走神了一下下，你再说一遍嘛 (๑•̀ㅂ•́)و✧';

  const keep = answer.includes('[[收藏]]');
  answer = answer.replace(/\[\[收藏\]\]/g, '').trim();
  for (const item of saved) {
    if (item.duplicate) continue;
    try {
      if (keep) {
        const targetFile = path.join(IMAGES_DIR, `${item.hash}.png`);
        if (!fs.existsSync(targetFile)) fs.copyFileSync(item.file, targetFile);
        addSticker(item.file, `收藏${item.hash.slice(0, 4)}`);
      }
      fs.unlinkSync(item.file);
    } catch { }
  }
  if (keep && saved.some(item => !item.duplicate)) logger.info('kept image(s) in album');

  const drawMatch = /\[\[画[:：]\s*([^\]\n]+)\]\]?/.exec(answer);
  if (drawMatch) {
    answer = answer.replace(/\[\[画[:：][^\]\n]*\]\]?/g, '').trim();
    const drawn = await drawImage(drawMatch[1].trim());
    if (drawn) setTimeout(() => sendImage(target, drawn), 1200);
    const saveMatch = /\[\[存表情[:：]\s*([^\]\n]+)\]\]?/.exec(answer);
    if (saveMatch) {
      answer = answer.replace(/\[\[存表情[:：][^\]\n]*\]\]?/g, '').trim();
      if (drawn) { addSticker(drawn, saveMatch[1].trim().slice(0, 12)); }
    } else setTimeout(() => sendText(target, '（呜，这次没画出来…等下我再试试）'), 900);
  }
  const stickerMatch = /\[\[图片[:：]\s*([^\]]+)\]\]/.exec(answer);
  const cleanText = answer.replace(/\[\[图片[:：][^\]]*\]\]/g, '').trim();
  list.push({ role: 'assistant', content: cleanText });
  history[key] = list.slice(-24);
  saveHistory(history);

  const wantsSong = /唱/.test(userText);
  const wantsVoice = /(语音|听听|声音|说句话|说一句)/.test(userText);
  if (wantsSong) {
    try {
      const { singWithHerVoice } = await import('./sing-her.mjs');
      const song = await singWithHerVoice(cleanText, [0, 0, 7, 7, 9, 9, 7, 5, 4, 2, 0]);
      if (song) sendRecord(target, song);
      else sendText(target, cleanText);
    } catch (error) {
      logger.error(`sing failed ${error.message}`);
      sendText(target, cleanText);
    }
  } else if (wantsVoice) {
    const voiceText = cleanText.replace(/[（(][^）)]*[）)]/g, '').slice(0, 120);
    const file = await ttsFile(voiceText || cleanText.slice(0, 80), { log: message => logger.info(message) });
    if (file) sendRecord(target, file);
    else sendText(target, cleanText);
  } else {
    sendText(target, cleanText);
  }
  if (stickerMatch) {
    const name = stickerMatch[1].trim();
    const file = findSticker(name) || resolveInside(STICKER_DIR, `${name}.png`);
    if (file && fs.existsSync(file)) setTimeout(() => sendImage(target, file), 900);
  }
}

function sendMessage(target, message) {
  if (target.groupId) {
    send({ action: 'send_group_msg', params: { group_id: target.groupId, message } });
  } else {
    send({ action: 'send_private_msg', params: { user_id: target.userId, message } });
  }
}

function sendText(target, text) {
  if (!text) return;
  sendMessage(target, [{ type: 'text', data: { text } }]);
  const where = target.groupId ? `group:${target.groupId}/${target.userId}` : target.userId;
  logger.info(`-> ${where}: ${text.slice(0, 60)}`);
}

function sendPrivate(userId, text) {
  sendText({ userId }, text);
}

function sendImage(target, file) {
  try {
    const base64 = fs.readFileSync(file).toString('base64');
    sendMessage(target, [{ type: 'image', data: { file: `base64://${base64}` } }]);
    const where = target.groupId ? `group:${target.groupId}` : target.userId;
    logger.info(`-> ${where}: [image] ${path.basename(file)}`);
  } catch (error) { logger.error(`image failed ${error.message}`); }
}

function sendRecord(target, file) {
  try {
    const base64 = fs.readFileSync(file).toString('base64');
    sendMessage(target, [{ type: 'record', data: { file: `base64://${base64}` } }]);
    const where = target.groupId ? `group:${target.groupId}` : target.userId;
    logger.info(`-> ${where}: [voice] ${path.basename(file)}`);
  } catch (error) { logger.error(`record failed ${error.message}`); }
}

async function handleMessage(event) {
  const liveConfig = getConfig();
  if (event.message_type === 'group') {
    if (!liveConfig.qq.allowGroup) return;
    const groupId = Number(event.group_id);
    if (liveConfig.qq.allowGroups.length && !liveConfig.qq.allowGroups.includes(groupId)) return;
  } else if (event.message_type !== 'private') {
    return;
  }
  const userId = Number(event.user_id);
  if (!userId || userId === selfId) return;
  if (liveConfig.qq.allowUins.length && !liveConfig.qq.allowUins.includes(userId)) {
    logger.info(`ignored stranger ${userId}`);
    return;
  }
  const target = event.message_type === 'group'
    ? { userId, groupId: Number(event.group_id) }
    : { userId };
  const text = textOf(event);
  const media = await mediaOf(event);
  const images = media.images;
  if (!text && !images.length) return;
  lastUserAt = Date.now();
  writeStatus();
  logger.info(`<- ${target.groupId ? `group:${target.groupId}/` : ''}${userId}: ${text.slice(0, 60)}${images.length ? ` [${images.length}帧/图]` : ''}`);
  try { await reply(target, text, images, media.saved); } catch (error) { logger.error(`reply failed ${error.message}`); }
}

// ---------------------------------------------------------------------------
// 主动消息
// ---------------------------------------------------------------------------
async function maybeProactive() {
  const liveConfig = getConfig();
  const proactive = liveConfig.qq.proactive;
  if (!proactive.enabled) return;
  const targetUser = liveConfig.qq.allowUins[0];
  if (!targetUser) return;

  const now = new Date();
  const hour = now.getHours();
  if (hour < proactive.startHour || hour >= proactive.endHour) return;
  const state = loadProactive();
  const today = now.toISOString().slice(0, 10);
  if (state.day !== today) { state.day = today; state.count = 0; }
  if (state.count >= proactive.maxPerDay) return;
  if (Date.now() - (state.lastAt || 0) < proactive.minGapMs) return;
  if (Date.now() - lastUserAt < proactive.quietAfterChatMs) return;
  const hints = [
    [8, 11, '早上主动跟主人打个招呼，问问他今天准备干嘛'],
    [11, 14, '中午了，主动问问主人吃饭了没、在忙什么'],
    [14, 18, '下午了，主动问问主人在干嘛、累不累'],
    [18, 22, '晚上了，主动问问主人今天过得怎么样'],
    [22, 24, '夜深了，主动关心一下主人怎么还不睡'],
  ];
  const hint = (hints.find(([from, to]) => hour >= from && hour < to) || [0, 0, '主动找主人说句话'])[2];
  const key = String(targetUser);
  const list = history[key] ?? [];
  const messages = [
    { role: 'system', content: `${persona()}\n\n你现在主动在 QQ 上给主人发消息（不是回复，是主动找他）。只输出一条很短的消息，一两句，口语、带点撒娇或关心、带颜文字；可以带一个 [[图片:名字]]。不要提 AI。` },
    ...list.slice(-6),
    { role: 'user', content: `（现在没人跟你说话，你主动发一条。提示：${hint}）` },
  ];
  try {
    const answer = await chat(messages, { maxTokens: Math.min(160, liveConfig.ai.maxTokens), temperature: liveConfig.ai.temperature });
    if (!answer) return;
    const sticker = /\[\[图片[:：]\s*([^\]]+)\]\]/.exec(answer);
    const text = answer.replace(/\[\[图片[:：][^\]]*\]\]/g, '').trim();
    try {
      const { notify: notifyUser } = await import('./notify.mjs');
      await notifyUser(text);
    } catch { sendPrivate(targetUser, text); }
    if (sticker) {
      const file = findSticker(sticker[1].trim());
      if (file) setTimeout(() => sendImage({ userId: targetUser }, file), 900);
    }
    list.push({ role: 'assistant', content: text });
    history[key] = list.slice(-24);
    saveHistory(history);
    state.lastAt = Date.now();
    state.count += 1;
    saveProactive(state);
    logger.info(`proactive sent (${state.count}/${proactive.maxPerDay})`);
  } catch (error) { logger.error(`proactive failed ${error.message}`); }
}

// ---------------------------------------------------------------------------
// 控制面：/healthz、/reload（仅容器内网）
// ---------------------------------------------------------------------------
function jsonResponse(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

const controlServer = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/healthz') {
    return jsonResponse(res, 200, { ok: true, service: 'bridge', online: Boolean(ws && ws.readyState === WebSocket.OPEN) });
  }
  if (url.pathname === '/reload') {
    if (req.method !== 'POST') return jsonResponse(res, 405, { ok: false, error: 'method not allowed' });
    if (req.headers['x-internal-token'] !== config.server.internalToken) return jsonResponse(res, 401, { ok: false, error: 'unauthorized' });
    applyReload('admin');
    return jsonResponse(res, 200, { ok: true, data: { reloaded: true } });
  }
  jsonResponse(res, 404, { ok: false, error: 'not found' });
});

controlServer.on('error', error => logger.error(`control server error ${error.message}`));
controlServer.listen(Number(process.env.CONTROL_PORT || config.server.bridgeControlPort), config.server.bind || '0.0.0.0', () => {
  logger.info(`bridge control listening on ${process.env.CONTROL_PORT || config.server.bridgeControlPort}`);
});

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
process.on('unhandledRejection', error => logger.error(`unhandledRejection ${error?.message || error}`));
process.on('uncaughtException', error => logger.error(`uncaughtException ${error?.message || error}`));

setInterval(() => writeStatus(), 15000);

// 面板“一键重启”：写标志位 -> 进程退出 -> compose restart 拉起
setInterval(() => {
  if (!fs.existsSync(RESTART_FLAG)) return;
  try { fs.unlinkSync(RESTART_FLAG); } catch { }
  logger.info('restart requested via admin, exiting for container restart');
  setTimeout(() => process.exit(0), 200);
}, 1500);

ensureDirs();
writeStatus();
logger.info('bridge starting');
connect();
setInterval(maybeProactive, 4 * 60 * 1000);

const FORCE = path.join(STATE_DIR, 'proactive-now');
if (fs.existsSync(FORCE)) {
  try { fs.unlinkSync(FORCE); } catch { }
  lastUserAt = 0;
  setTimeout(maybeProactive, 6000);
}

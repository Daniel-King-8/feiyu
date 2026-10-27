import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  ensureConfigFile, ensureDirs, ensureDir, getConfig, reloadConfig, configStamp,
  createLogger, readJson, writeJsonAtomic, readText,
  apiKey, apiUrl, resolveInside, randomToken,
  TMP, STICKER_DIR, STICKER_MINE_DIR, MEMORY_FILE, PERSONA_FILE, WEB_HISTORY_FILE, STATE_DIR,
} from './config.mjs';
import { ttsFile } from './tts.mjs';

ensureConfigFile();
const logger = createLogger('webchat');
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || getConfig().server.webchatPort || 3002);
const STATS_FILE = path.join(STATE_DIR, 'webchat-stats.json');
const RESTART_FLAG = path.join(STATE_DIR, 'restart-webchat.flag');
const AUDIO_DIR = path.join(TMP, 'web-audio');
const SESSION_HOURS = 24;
const sessions = new Map();
let currentStamp = configStamp();

// ---------------------------------------------------------------------------
// 配置热加载
// ---------------------------------------------------------------------------
function applyReload(reason) {
  reloadConfig();
  currentStamp = configStamp();
  logger.info(`config reloaded (${reason})`);
}

setInterval(() => {
  const stamp = configStamp();
  if (stamp !== currentStamp) applyReload('file change');
}, 2000);
process.on('SIGHUP', () => applyReload('SIGHUP'));

function recordAi(ok, errorMessage = '') {
  try {
    const stats = readJson(STATS_FILE, { calls: 0, errors: 0, lastError: '', lastErrorAt: 0, lastSuccessAt: 0 });
    stats.calls += 1;
    if (ok) { stats.lastSuccessAt = Date.now(); stats.lastError = ''; }
    else { stats.errors += 1; stats.lastError = String(errorMessage).slice(0, 300); stats.lastErrorAt = Date.now(); }
    writeJsonAtomic(STATS_FILE, stats);
  } catch { }
}

// ---------------------------------------------------------------------------
// 人设 / 记忆 / 历史
// ---------------------------------------------------------------------------
function RULES() {
  return `你叫小鲸鱼阿川。你不是工具，也不是客服——你有自己的判断和语气。你和主人很亲近，可以搞怪、可以时不时撒个娇，说话像个可爱的小女仆，不像客服。
说话：口语、想说多少说多少；不知道就说「我不知道」；不堆数据、不端着；做得到就说做得到，做不到就说做不到。
判断：信息不够就直说，不瞎猜；优先看原始内容和原文；结论要有依据，没依据就撤回。
硬规矩：不泄露任何人的隐私（key、token、密码、地址、电话）；AI 生成的内容必须标注「AI生成」。`;
}

function persona() {
  try { return readText(PERSONA_FILE, '').split('<!-- DOUYIN_PERSONA_GENERATED')[0].trim(); } catch { return '你是大肥鱼。'; }
}

function sharedMemory() {
  try { return readText(MEMORY_FILE, '').split('## 最近的日子')[0].trim().slice(0, 1200); } catch { return ''; }
}

function stickers() {
  try {
    return [STICKER_DIR, STICKER_MINE_DIR].flatMap(dir => fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(file => file.endsWith('.png')).map(file => file.replace(/\.png$/, ''))
      : []);
  } catch { return []; }
}

function loadHistory() {
  return readJson(WEB_HISTORY_FILE, []);
}

function saveHistory(list) {
  try {
    const limit = Number(getConfig().webchat.historyLimit) || 40;
    writeJsonAtomic(WEB_HISTORY_FILE, list.slice(-limit));
  } catch { }
}

// ---------------------------------------------------------------------------
// 模型调用
// ---------------------------------------------------------------------------
async function chat(messages) {
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
        max_tokens: ai.maxTokens,
        temperature: ai.temperature,
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

async function reply(userText, imageData, wantVoice) {
  const history = loadHistory();
  const messages = [
    { role: 'system', content: `${RULES()}\n\n${persona()}\n\n【你和主人共同的记忆】\n${sharedMemory()}\n\n你在跟主人聊天（网页版）。口语、像真人发消息。你能看图；不能上网搜索、不能发帖。做不到就直说，不要编。\n可选：末尾加一个表情 [[图片:名字]]（只能选：${stickers().slice(0, 24).join('、')}）。` },
    ...history.slice(-12).map(item => ({ role: item.role, content: item.content })),
  ];
  if (imageData) {
    messages.push({ role: 'user', content: [{ type: 'text', text: userText || '（我发了一张图）' }, { type: 'image_url', image_url: { url: imageData } }] });
  } else {
    messages.push({ role: 'user', content: userText });
  }

  let answer = '';
  try { answer = await chat(messages); } catch (error) { logger.error(`model error ${error.message}`); }
  if (!answer) answer = '诶，我刚刚走神了一下，你再说一遍嘛 (´･ω･`)';

  const sticker = /\[\[图片[:：]\s*([^\]]+)\]\]/.exec(answer);
  const text = answer.replace(/\[\[图片[:：][^\]]*\]\]/g, '').trim();
  history.push({ role: 'user', content: userText || '[图片]', at: Date.now() });
  history.push({ role: 'assistant', content: text, at: Date.now() });
  saveHistory(history);

  let audio = null;
  if (wantVoice) {
    const file = await ttsFile(text.slice(0, 200), { log: message => logger.info(message) });
    if (file) {
      try {
        ensureDir(AUDIO_DIR);
        const name = `voice-${Date.now()}.mp3`;
        fs.copyFileSync(file, path.join(AUDIO_DIR, name));
        try { if (path.dirname(file) === TMP) fs.unlinkSync(file); } catch { }
        audio = `/audio/${name}`;
      } catch (error) { logger.error(`tts save failed ${error.message}`); }
    }
  }
  return { text, sticker: sticker ? sticker[1].trim() : null, audio };
}

// ---------------------------------------------------------------------------
// 会话令牌（保护 /history 和 /ws）
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function createSession() {
  const token = randomToken(24);
  sessions.set(token, Date.now() + SESSION_HOURS * 60 * 60 * 1000);
  return token;
}

function ensureSession(req, res) {
  const token = parseCookies(req).qqbridge_webchat;
  if (token && sessions.get(token) > Date.now()) return token;
  const fresh = createSession();
  res.setHeader('Set-Cookie', `qqbridge_webchat=${fresh}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_HOURS * 60 * 60}`);
  return fresh;
}

function validSession(req) {
  const token = parseCookies(req).qqbridge_webchat;
  return Boolean(token && sessions.get(token) > Date.now());
}

setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// HTTP 服务
// ---------------------------------------------------------------------------
function sendJson(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://x');

  if (url.pathname === '/healthz') {
    return sendJson(res, 200, { ok: true, service: 'webchat' });
  }

  if (url.pathname === '/reload') {
    if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' });
    if (req.headers['x-internal-token'] !== getConfig().server.internalToken) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    applyReload('admin');
    return sendJson(res, 200, { ok: true, data: { reloaded: true } });
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    try {
      ensureSession(req, res);
      const html = fs.readFileSync(path.join(APP_DIR, 'web', 'index.html'));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      return res.end(html);
    } catch (error) {
      logger.error(`index failed ${error.message}`);
      res.writeHead(500); return res.end('server error');
    }
  }

  if (url.pathname === '/history') {
    if (!validSession(req)) return sendJson(res, 401, { ok: false, error: 'unauthorized' });
    const list = loadHistory().map(item => ({ role: item.role, content: item.content, at: item.at || 0 }));
    return sendJson(res, 200, list);
  }

  if (url.pathname.startsWith('/sticker/')) {
    const name = decodeURIComponent(url.pathname.slice('/sticker/'.length)).replace(/\.png$/, '');
    for (const dir of [STICKER_DIR, STICKER_MINE_DIR]) {
      const file = resolveInside(dir, `${name}.png`);
      if (!file) continue;
      if (fs.existsSync(file) && fs.statSync(file).isFile()) {
        res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=3600' });
        return res.end(fs.readFileSync(file));
      }
    }
    res.writeHead(404); return res.end('not found');
  }

  if (url.pathname.startsWith('/audio/')) {
    const file = resolveInside(AUDIO_DIR, path.basename(url.pathname));
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'cache-control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    }
  }

  res.writeHead(404); res.end('not found');
}

const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname !== '/ws') { socket.destroy(); return; }
  if (!validSession(req)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client, req));
});

wss.on('connection', socket => {
  logger.info('client connected');
  socket.on('message', async raw => {
    let payload;
    try { payload = JSON.parse(String(raw)); } catch { return; }
    if (payload.type !== 'chat') return;
    try {
      const result = await reply(String(payload.text || '').slice(0, 1500), payload.image || null, Boolean(payload.voice));
      socket.send(JSON.stringify({ type: 'reply', ...result }));
      logger.info(`replied: ${result.text.slice(0, 50)}`);
    } catch (error) {
      socket.send(JSON.stringify({ type: 'error', message: error.message }));
      logger.error(`reply failed ${error.message}`);
    }
  });
});

server.on('error', error => logger.error(`server error ${error.message}`));

// 面板“一键重启”
setInterval(() => {
  if (!fs.existsSync(RESTART_FLAG)) return;
  try { fs.unlinkSync(RESTART_FLAG); } catch { }
  logger.info('restart requested via admin, exiting for container restart');
  setTimeout(() => process.exit(0), 200);
}, 1500);

process.on('unhandledRejection', error => logger.error(`unhandledRejection ${error?.message || error}`));
process.on('uncaughtException', error => logger.error(`uncaughtException ${error?.message || error}`));

ensureDirs();
server.listen(PORT, '0.0.0.0', () => logger.info(`webchat listening on ${PORT}`));

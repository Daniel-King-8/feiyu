import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import {
  ensureConfigFile, ensureDirs, ensureDir, getConfig, saveConfig, reloadConfig,
  createLogger, readJson, writeJsonAtomic, readText, writeTextAtomic,
  maskConfig, isMasked, applySecretMask, backupFile, normalizeUins, deepMerge,
  hashPassword, verifyPassword, generatePassword, randomToken,
  VERSION, DATA_DIR, TMP, BACKUP_DIR, LOG_DIR, STATE_DIR,
  STICKER_DIR, STICKER_MINE_DIR, MEMORY_FILE, PERSONA_FILE, HISTORY_FILE, WEB_HISTORY_FILE,
  CONFIG_FILE, safeFileName, resolveInside,
} from './config.mjs';
import { ttsFile } from './tts.mjs';

ensureConfigFile();
ensureDirs();
const logger = createLogger('admin');
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = path.join(APP_DIR, 'web', 'admin', 'index.html');
const PORT = Number(process.env.PORT || getConfig().server.adminPort || 8080);
const BIND = process.env.BIND || getConfig().server.bind || '0.0.0.0';
const ADMIN_STATS = path.join(STATE_DIR, 'admin-stats.json');
const sessions = new Map();
const loginAttempts = new Map();
const COOKIE_NAME = 'qqbridge_admin';
const TTS_TEST_TEXT = '你好呀，我是大肥鱼，这是一段语音试听。';

let config = getConfig();

// ---------------------------------------------------------------------------
// 首次启动：生成随机密码
// ---------------------------------------------------------------------------
function ensureAdminPassword() {
  config = getConfig();
  if (config.auth.passwordHash) return;
  const password = generatePassword(16);
  config = saveConfig({ auth: { passwordHash: hashPassword(password), mustChange: true } });
  logger.info(`首次启动：管理员初始密码是 ${password} （登录后请立即修改）`);
  console.log('\n============================================');
  console.log('  QQ Bridge 配置面板初始密码');
  console.log(`  ${password}`);
  console.log('============================================\n');
}
ensureAdminPassword();

// ---------------------------------------------------------------------------
// HTTP 基础
// ---------------------------------------------------------------------------
function commonHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self'; base-uri 'none'; form-action 'self'");
}

function sendJson(res, status, value) {
  commonHeaders(res);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function sendOk(res, data = {}) { sendJson(res, 200, { ok: true, data }); }
function sendError(res, status, error) { sendJson(res, status, { ok: false, error }); }

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) {
        const error = new Error('body too large');
        error.code = 'LIMIT';
        reject(error);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readJsonBody(req, limit = 2 * 1024 * 1024) {
  const buffer = await readBody(req, limit);
  if (!buffer.length) return {};
  const parsed = JSON.parse(buffer.toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 需要是对象');
  return parsed;
}

function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    out[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return out;
}

function sessionToken(req) {
  return parseCookies(req)[COOKIE_NAME] || '';
}

function validSession(req) {
  const token = sessionToken(req);
  return Boolean(token && sessions.get(token) && sessions.get(token) > Date.now());
}

function requireAuth(req, res) {
  if (validSession(req)) return true;
  sendError(res, 401, '未登录或会话已过期');
  return false;
}

function createSession(res) {
  const token = randomToken(32);
  const hours = Math.max(1, Number(getConfig().auth.sessionHours) || 24);
  sessions.set(token, Date.now() + hours * 60 * 60 * 1000);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${hours * 60 * 60}`);
  return token;
}

function clearSession(req, res) {
  const token = sessionToken(req);
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
}

function clientIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

function loginBlocked(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || entry.reset <= now) {
    loginAttempts.set(ip, { count: 0, reset: now + 10 * 60 * 1000 });
    return false;
  }
  return entry.count >= 5;
}

function noteLoginFailure(ip) {
  const now = Date.now();
  const entry = loginAttempts.get(ip) || { count: 0, reset: now + 10 * 60 * 1000 };
  if (entry.reset <= now) { entry.count = 0; entry.reset = now + 10 * 60 * 1000; }
  entry.count += 1;
  loginAttempts.set(ip, entry);
}

// ---------------------------------------------------------------------------
// 服务状态 / 统计
// ---------------------------------------------------------------------------
function serviceUrl(key) {
  const server = getConfig().server;
  return String(server[key] || '').replace(/\/+$/, '');
}

async function checkHttp(baseUrl) {
  if (!baseUrl) return { online: false, error: '未配置地址' };
  try {
    const response = await fetch(`${baseUrl}/healthz`, { signal: AbortSignal.timeout(1800) });
    if (!response.ok) return { online: false, error: `HTTP ${response.status}` };
    const data = await response.json().catch(() => ({}));
    return { online: true, detail: data };
  } catch (error) {
    return { online: false, error: error.message };
  }
}

function checkTcp(wsUrl) {
  return new Promise(resolve => {
    let target;
    try { target = new URL(wsUrl); } catch { return resolve({ online: false, error: 'WS 地址无效' }); }
    const port = Number(target.port) || (target.protocol === 'wss:' ? 443 : 80);
    const socket = net.createConnection({ host: target.hostname, port });
    let settled = false;
    const done = value => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { }
      resolve(value);
    };
    socket.setTimeout(1800);
    socket.on('connect', () => done({ online: true, host: target.hostname, port }));
    socket.on('timeout', () => done({ online: false, error: '连接超时' }));
    socket.on('error', error => done({ online: false, error: error.message }));
  });
}

function aggregateStats() {
  const files = [
    ['bridge', path.join(STATE_DIR, 'bridge-stats.json')],
    ['webchat', path.join(STATE_DIR, 'webchat-stats.json')],
    ['admin', ADMIN_STATS],
  ];
  const result = { calls: 0, errors: 0, lastError: '', lastErrorAt: 0, lastSuccessAt: 0, sources: {} };
  for (const [name, file] of files) {
    const stats = readJson(file, null);
    if (!stats) continue;
    result.sources[name] = stats;
    result.calls += Number(stats.calls || 0);
    result.errors += Number(stats.errors || 0);
    if (Number(stats.lastErrorAt || 0) > result.lastErrorAt) {
      result.lastErrorAt = Number(stats.lastErrorAt || 0);
      result.lastError = String(stats.lastError || '');
    }
    result.lastSuccessAt = Math.max(result.lastSuccessAt, Number(stats.lastSuccessAt || 0));
  }
  return result;
}

function recordAdminAi(ok, errorMessage = '') {
  try {
    const stats = readJson(ADMIN_STATS, { calls: 0, errors: 0, lastError: '', lastErrorAt: 0, lastSuccessAt: 0 });
    stats.calls += 1;
    if (ok) { stats.lastSuccessAt = Date.now(); stats.lastError = ''; }
    else { stats.errors += 1; stats.lastError = String(errorMessage).slice(0, 300); stats.lastErrorAt = Date.now(); }
    writeJsonAtomic(ADMIN_STATS, stats);
  } catch { }
}

function diskInfo() {
  try {
    const stat = fs.statfsSync(DATA_DIR);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return { total, free, used: Math.max(0, total - free) };
  } catch {
    return { total: 0, free: 0, used: 0 };
  }
}

async function statusPayload() {
  const current = getConfig();
  const bridgeStatus = readJson(path.join(STATE_DIR, 'bridge-status.json'), {});
  const bridgeUpdatedAt = Date.parse(bridgeStatus.updatedAt || '') || 0;
  const bridgeFresh = Date.now() - bridgeUpdatedAt < 90 * 1000;
  const qqOnline = Boolean(bridgeStatus.online && bridgeFresh);
  const [napcat, bridge, webchat] = await Promise.all([
    checkTcp(current.qq.wsUrl),
    checkHttp(serviceUrl('bridgeUrl')),
    checkHttp(serviceUrl('webchatUrl')),
  ]);
  return {
    version: VERSION,
    uptime: Math.floor(process.uptime()),
    services: {
      napcat,
      bridge: { ...bridge, qq: { online: qqOnline, selfId: bridgeStatus.selfId || 0, nickname: bridgeStatus.nickname || '', updatedAt: bridgeStatus.updatedAt || '' } },
      webchat,
      admin: { online: true },
    },
    qq: {
      wsUrl: current.qq.wsUrl,
      online: qqOnline,
      selfId: bridgeStatus.selfId || current.qq.selfId || 0,
      nickname: bridgeStatus.nickname || '',
      allowGroup: current.qq.allowGroup,
      allowUins: current.qq.allowUins.length,
    },
    deepseek: aggregateStats(),
    disk: diskInfo(),
    automation: {
      enabled: Boolean(current.automation.enabled),
      watch: Boolean(current.automation.watch),
      replyComments: Boolean(current.automation.replyComments),
      dynamic: Boolean(current.automation.dynamic),
      mention: Boolean(current.automation.mention),
    },
    mustChangePassword: Boolean(current.auth.mustChange),
    dataDir: DATA_DIR,
  };
}

// ---------------------------------------------------------------------------
// 配置保存 / 热加载通知
// ---------------------------------------------------------------------------
async function notifyServicesReload() {
  const current = getConfig();
  const targets = [
    ['bridge', serviceUrl('bridgeUrl')],
    ['webchat', serviceUrl('webchatUrl')],
  ];
  await Promise.all(targets.map(async ([name, base]) => {
    if (!base) return;
    try {
      const response = await fetch(`${base}/reload`, {
        method: 'POST',
        headers: { 'x-internal-token': current.server.internalToken },
        signal: AbortSignal.timeout(2500),
      });
      logger.info(`reload notify ${name}: HTTP ${response.status}`);
    } catch (error) {
      logger.warn(`reload notify ${name} failed: ${error.message}`);
    }
  }));
}

function sanitizePatch(patch) {
  const clean = JSON.parse(JSON.stringify(patch || {}));
  delete clean.auth;
  if (clean.server) {
    delete clean.server.internalToken;
    delete clean.server.adminPort;
    delete clean.server.webchatPort;
    delete clean.server.bridgeControlPort;
  }
  if (clean.qq) {
    if ('allowUins' in clean.qq) clean.qq.allowUins = normalizeUins(clean.qq.allowUins);
    if ('allowGroups' in clean.qq) clean.qq.allowGroups = normalizeUins(clean.qq.allowGroups);
  }
  return clean;
}

async function saveFromPanel(patch) {
  const current = getConfig();
  backupFile(CONFIG_FILE, 'config_');
  const cleaned = applySecretMask(sanitizePatch(patch), current);
  const next = saveConfig(cleaned, { merge: true });
  config = next;
  logger.info(`configuration saved by panel (${Object.keys(cleaned).join(', ') || 'empty'})`);
  await notifyServicesReload();
  return maskConfig(next);
}

// ---------------------------------------------------------------------------
// 静态页面 / 登录
// ---------------------------------------------------------------------------
function serveAdminPage(res) {
  try {
    const html = fs.readFileSync(ADMIN_HTML);
    commonHeaders(res);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  } catch (error) {
    logger.error(`admin page missing: ${error.message}`);
    res.writeHead(500); res.end('admin page missing');
  }
}

async function handleLogin(req, res) {
  const ip = clientIp(req);
  if (loginBlocked(ip)) return sendError(res, 429, '尝试次数过多，请 10 分钟后再试');
  let body;
  try { body = await readJsonBody(req, 64 * 1024); } catch (error) { return sendError(res, 400, error.message); }
  const password = String(body.password || '');
  config = getConfig();
  if (!config.auth.passwordHash || !verifyPassword(password, config.auth.passwordHash)) {
    noteLoginFailure(ip);
    logger.warn(`login failed from ${ip}`);
    return sendError(res, 401, '密码错误');
  }
  loginAttempts.delete(ip);
  createSession(res);
  logger.info(`login success from ${ip}`);
  return sendOk(res, { mustChangePassword: Boolean(config.auth.mustChange) });
}

async function handlePassword(req, res) {
  const body = await readJsonBody(req, 64 * 1024);
  const oldPassword = String(body.oldPassword || '');
  const newPassword = String(body.newPassword || '');
  config = getConfig();
  if (!verifyPassword(oldPassword, config.auth.passwordHash)) return sendError(res, 400, '原密码不正确');
  if (newPassword.length < 8) return sendError(res, 400, '新密码至少 8 位');
  if (newPassword === oldPassword) return sendError(res, 400, '新密码不能与原密码相同');
  config = saveConfig({ auth: { passwordHash: hashPassword(newPassword), mustChange: false } });
  const keep = sessionToken(req);
  for (const token of sessions.keys()) if (token !== keep) sessions.delete(token);
  logger.info('admin password changed');
  return sendOk(res, { changed: true });
}

// ---------------------------------------------------------------------------
// AI / TTS / QQ 测试
// ---------------------------------------------------------------------------
function chatEndpoint(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  return base.endsWith('/chat/completions') ? base : `${base}/chat/completions`;
}

async function testAi(body) {
  config = getConfig();
  const baseUrl = String(body.baseUrl || config.ai.baseUrl || 'https://api.deepseek.com');
  let key = String(body.apiKey || '').trim();
  if (!key || isMasked(key)) key = config.ai.apiKey || process.env.DEEPSEEK_API_KEY || '';
  if (!key) throw new Error('未配置 API Key');
  const model = String(body.model || config.ai.model || 'deepseek-chat');
  const temperature = body.temperature === undefined ? 0 : Number(body.temperature);
  const started = Date.now();
  const response = await fetch(chatEndpoint(baseUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify({ model, messages: [{ role: 'user', content: 'ping' }], max_tokens: 32, temperature }),
    signal: AbortSignal.timeout(30000),
  });
  const latencyMs = Date.now() - started;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message = data?.error?.message || `HTTP ${response.status}`;
    recordAdminAi(false, message);
    const error = new Error(message);
    error.status = response.status;
    error.latencyMs = latencyMs;
    throw error;
  }
  recordAdminAi(true);
  return {
    latencyMs,
    status: response.status,
    model: data?.model || model,
    reply: data?.choices?.[0]?.message?.content || '',
    usage: data?.usage || null,
  };
}

async function testTts(body) {
  config = getConfig();
  let effective = config;
  if (body && body.tts && typeof body.tts === 'object') {
    const doubao = {};
    for (const key of ['apiKey', 'voiceId', 'resource', 'uid', 'instruction']) {
      const value = body.tts?.doubao?.[key];
      if (value !== undefined && value !== '' && !isMasked(value)) doubao[key] = value;
    }
    if (Object.keys(doubao).length) effective = deepMerge(config, { tts: { doubao } });
  }
  if (body && body.tts && body.tts.edge && typeof body.tts.edge === 'object') {
    const edge = {};
    if ('enabled' in body.tts.edge) edge.enabled = Boolean(body.tts.edge.enabled);
    if (typeof body.tts.edge.voice === 'string' && body.tts.edge.voice.trim()) edge.voice = body.tts.edge.voice.trim();
    if (Object.keys(edge).length) effective = deepMerge(effective, { tts: { edge } });
  }
  const file = await ttsFile(TTS_TEST_TEXT, { cfg: effective, log: message => logger.info(`tts test: ${message}`) });
  if (!file) throw new Error('豆包语音与 edge-tts 均未成功，请检查配置');
  const buffer = fs.readFileSync(file);
  try { if (file.startsWith(TMP)) fs.unlinkSync(file); } catch { }
  return buffer;
}

function testQq() {
  return new Promise(resolve => {
    config = getConfig();
    const started = Date.now();
    const token = config.qq.accessToken;
    let settled = false;
    const ws = new WebSocket(config.qq.wsUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { }
      resolve({ latencyMs: Date.now() - started, ...value });
    };
    const timer = setTimeout(() => finish({ online: false, error: '连接超时' }), 8000);
    ws.on('open', () => ws.send(JSON.stringify({ action: 'get_login_info', echo: 'admin-test' })));
    ws.on('message', data => {
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      if (parsed.echo !== 'admin-test') return;
      finish({
        online: parsed.retcode === 0,
        selfId: parsed.data?.user_id || 0,
        nickname: parsed.data?.nickname || '',
        error: parsed.retcode === 0 ? '' : (parsed.message || parsed.wording || `retcode ${parsed.retcode}`),
      });
    });
    ws.on('error', error => finish({ online: false, error: error.message }));
  });
}

// ---------------------------------------------------------------------------
// 日志读取
// ---------------------------------------------------------------------------
const LOG_SERVICES = new Set(['bridge', 'webchat', 'admin', 'notify', 'watch', 'dynamic', 'mention', 'reply-comments', 'learn', 'research', 'diary', 'share', 'signature', 'balance', 'proactive-slot']);

function logFilesFor(svc) {
  const files = [];
  try {
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (file === `${svc}.log` || (file.startsWith(`${svc}-`) && file.endsWith('.log'))) {
        const full = path.join(LOG_DIR, file);
        try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { }
      }
    }
  } catch { }
  return files.sort((a, b) => b.mtime - a.mtime);
}

function readLogs(svc, limit, keyword) {
  const files = logFilesFor(svc);
  let collected = [];
  for (const { full } of files) {
    let lines = [];
    try { lines = fs.readFileSync(full, 'utf8').split(/\r?\n/); } catch { continue; }
    const remaining = 5000 - collected.length;
    if (remaining <= 0) break;
    collected = lines.slice(-remaining).concat(collected);
  }
  if (keyword) {
    const needle = keyword.toLowerCase();
    collected = collected.filter(line => line.toLowerCase().includes(needle));
  }
  return collected.filter(Boolean).slice(-limit);
}

// ---------------------------------------------------------------------------
// 表情库
// ---------------------------------------------------------------------------
function stickerEntries() {
  const entries = [];
  for (const [dir, bucket] of [[STICKER_DIR, 'main'], [STICKER_MINE_DIR, 'mine']]) {
    try {
      for (const file of fs.readdirSync(dir)) {
        if (!file.endsWith('.png')) continue;
        const full = path.join(dir, file);
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        entries.push({
          name: file.replace(/\.png$/, ''),
          bucket,
          size: stat.size,
          mtime: stat.mtimeMs,
          url: `/api/stickers/${encodeURIComponent(file.replace(/\.png$/, ''))}`,
        });
      }
    } catch { }
  }
  return entries.sort((a, b) => b.mtime - a.mtime);
}

function findStickerFile(name) {
  const safe = safeFileName(name);
  if (!safe) return null;
  for (const dir of [STICKER_DIR, STICKER_MINE_DIR]) {
    const file = resolveInside(dir, `${safe}.png`);
    if (file && fs.existsSync(file) && fs.statSync(file).isFile()) return file;
  }
  return null;
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!match) throw new Error('multipart 缺少 boundary');
  const boundaryText = (match[1] || match[2] || '').trim();
  if (!boundaryText) throw new Error('multipart boundary 无效');
  const boundary = Buffer.from(`--${boundaryText}`);
  const fields = {};
  const files = [];
  let cursor = buffer.indexOf(boundary);
  while (cursor !== -1) {
    const partStart = cursor + boundary.length;
    if (buffer.slice(partStart, partStart + 2).toString() === '--') break;
    const headerStart = buffer.indexOf('\r\n\r\n', partStart);
    if (headerStart === -1) break;
    const nextBoundary = buffer.indexOf(boundary, headerStart + 4);
    if (nextBoundary === -1) break;
    const headerText = buffer.slice(partStart + 2, headerStart).toString('utf8');
    const content = buffer.slice(headerStart + 4, Math.max(headerStart + 4, nextBoundary - 2));
    const nameMatch = /name="([^"]*)"/i.exec(headerText);
    const fileMatch = /filename="([^"]*)"/i.exec(headerText);
    const fieldName = nameMatch ? nameMatch[1] : '';
    if (fileMatch) {
      files.push({ field: fieldName, filename: fileMatch[1], data: content });
    } else if (fieldName) {
      fields[fieldName] = content.toString('utf8');
    }
    cursor = nextBoundary;
  }
  return { fields, files };
}

async function uploadSticker(req, res) {
  const buffer = await readBody(req, 4 * 1024 * 1024);
  const { fields, files } = parseMultipart(buffer, req.headers['content-type']);
  const file = files.find(item => item.field === 'file') || files[0];
  if (!file || !file.data.length) return sendError(res, 400, '没有收到图片文件');
  if (file.data.length > 2 * 1024 * 1024) return sendError(res, 413, '图片不能超过 2MB');
  const requestedName = safeFileName(fields.name || path.parse(file.filename || '').name || `sticker-${Date.now()}`);
  if (!requestedName) return sendError(res, 400, '表情名称不合法');
  const finalPath = path.join(STICKER_DIR, `${requestedName}.png`);
  const minePath = path.join(STICKER_MINE_DIR, `${requestedName}.png`);
  if ((fs.existsSync(finalPath) || fs.existsSync(minePath)) && fields.overwrite !== '1') {
    return sendError(res, 409, '同名表情已存在');
  }

  ensureDir(TMP);
  const tempInput = path.join(TMP, `upload-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const tempOutput = path.join(TMP, `sticker-${Date.now()}.png`);
  try {
    fs.writeFileSync(tempInput, file.data);
    execFileSync('ffmpeg', [
      '-y', '-i', tempInput,
      '-vf', 'scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=0x00000000',
      '-frames:v', '1', tempOutput,
    ], { timeout: 30000, stdio: 'ignore' });
    if (!fs.existsSync(tempOutput) || fs.statSync(tempOutput).size < 500) throw new Error('图片转码失败');
    fs.copyFileSync(tempOutput, finalPath);
    logger.info(`sticker uploaded ${requestedName} (${fs.statSync(finalPath).size} bytes)`);
    return sendOk(res, { name: requestedName, size: fs.statSync(finalPath).size });
  } finally {
    for (const file of [tempInput, tempOutput]) { try { fs.unlinkSync(file); } catch { } }
  }
}

// ---------------------------------------------------------------------------
// 路由
// ---------------------------------------------------------------------------
async function handleApi(req, res, url) {
  const method = req.method || 'GET';
  const pathname = url.pathname;
  const ip = clientIp(req);

  if (pathname === '/api/login' && method === 'POST') return handleLogin(req, res);

  if (!requireAuth(req, res)) return;
  const token = sessionToken(req);

  if (pathname === '/api/logout' && method === 'POST') {
    clearSession(req, res);
    return sendOk(res, { loggedOut: true });
  }

  if (pathname === '/api/status' && method === 'GET') {
    return sendOk(res, await statusPayload());
  }

  if (pathname === '/api/config' && method === 'GET') {
    return sendOk(res, maskConfig(getConfig()));
  }

  if (pathname === '/api/config' && method === 'PUT') {
    const patch = await readJsonBody(req, 2 * 1024 * 1024);
    const saved = await saveFromPanel(patch);
    return sendOk(res, saved);
  }

  if (pathname === '/api/password' && method === 'POST') {
    return handlePassword(req, res);
  }

  if (pathname === '/api/test/ai' && method === 'POST') {
    const body = await readJsonBody(req, 256 * 1024);
    try { return sendOk(res, await testAi(body)); }
    catch (error) { logger.error(`test ai failed: ${error.message}`); return sendJson(res, 502, { ok: false, error: error.message, data: { latencyMs: error.latencyMs || 0, status: error.status || 0 } }); }
  }

  if (pathname === '/api/test/tts' && method === 'POST') {
    let body = {};
    try { body = await readJsonBody(req, 256 * 1024); } catch { body = {}; }
    try {
      const audio = await testTts(body);
      commonHeaders(res);
      res.writeHead(200, { 'content-type': 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'no-store' });
      return res.end(audio);
    } catch (error) {
      logger.error(`test tts failed: ${error.message}`);
      return sendJson(res, 502, { ok: false, error: error.message });
    }
  }

  if (pathname === '/api/test/qq' && method === 'POST') {
    const result = await testQq();
    return sendOk(res, result);
  }

  if (pathname === '/api/logs' && method === 'GET') {
    const svc = String(url.searchParams.get('svc') || 'bridge');
    if (!LOG_SERVICES.has(svc)) return sendError(res, 400, '未知服务');
    const requestedLines = Number(url.searchParams.get('lines') || 500);
    const limit = Number.isFinite(requestedLines) ? Math.min(2000, Math.max(10, Math.trunc(requestedLines))) : 500;
    const keyword = String(url.searchParams.get('q') || '').slice(0, 200);
    const files = logFilesFor(svc).map(item => path.basename(item.full));
    return sendOk(res, { svc, lines: readLogs(svc, limit, keyword), files });
  }

  if (pathname === '/api/memory/role') {
    if (method === 'GET') return sendOk(res, { content: readText(PERSONA_FILE, ''), file: 'role-card.md' });
    if (method === 'PUT') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const content = String(body.content ?? '');
      if (content.length > 1024 * 1024) return sendError(res, 413, '内容过大');
      backupFile(PERSONA_FILE, 'memory_');
      writeTextAtomic(PERSONA_FILE, content);
      logger.info(`persona saved (${content.length} chars)`);
      return sendOk(res, { saved: true, length: content.length });
    }
  }

  if (pathname === '/api/memory/shared') {
    if (method === 'GET') return sendOk(res, { content: readText(MEMORY_FILE, ''), file: 'shared-memory.md' });
    if (method === 'PUT') {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const content = String(body.content ?? '');
      if (content.length > 1024 * 1024) return sendError(res, 413, '内容过大');
      backupFile(MEMORY_FILE, 'memory_');
      writeTextAtomic(MEMORY_FILE, content);
      logger.info(`shared memory saved (${content.length} chars)`);
      return sendOk(res, { saved: true, length: content.length });
    }
  }

  if (pathname === '/api/history/clear' && method === 'POST') {
    backupFile(HISTORY_FILE, 'history_');
    backupFile(WEB_HISTORY_FILE, 'history_');
    writeJsonAtomic(HISTORY_FILE, {});
    writeJsonAtomic(WEB_HISTORY_FILE, []);
    logger.info(`chat history cleared by ${ip}`);
    return sendOk(res, { cleared: true });
  }

  if (pathname === '/api/stickers' && method === 'GET') {
    return sendOk(res, { stickers: stickerEntries(), dir: STICKER_DIR });
  }

  if (pathname === '/api/stickers' && method === 'POST') {
    try { return await uploadSticker(req, res); }
    catch (error) { logger.error(`sticker upload failed: ${error.message}`); return sendError(res, 500, error.message); }
  }

  if (pathname.startsWith('/api/stickers/')) {
    const name = decodeURIComponent(pathname.slice('/api/stickers/'.length));
    if (method === 'GET') {
      const file = findStickerFile(name);
      if (!file) return sendError(res, 404, '表情不存在');
      commonHeaders(res);
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      return res.end(fs.readFileSync(file));
    }
    if (method === 'DELETE') {
      const file = findStickerFile(name);
      if (!file) return sendError(res, 404, '表情不存在');
      const base = path.resolve(file).startsWith(path.resolve(STICKER_MINE_DIR) + path.sep) ? STICKER_MINE_DIR : STICKER_DIR;
      if (!resolveInside(base, path.basename(file))) return sendError(res, 400, '路径不合法');
      fs.unlinkSync(file);
      logger.info(`sticker deleted ${name}`);
      return sendOk(res, { deleted: name });
    }
  }

  if (pathname === '/api/restart' && method === 'POST') {
    const svc = String(url.searchParams.get('svc') || '');
    if (!['bridge', 'webchat'].includes(svc)) return sendError(res, 400, 'svc 只能是 bridge 或 webchat');
    writeTextAtomic(path.join(STATE_DIR, `restart-${svc}.flag`), new Date().toISOString());
    logger.info(`restart flag written for ${svc} by ${ip}`);
    return sendOk(res, { svc, requested: true });
  }

  if (pathname === '/api/export' && method === 'GET') {
    const mode = String(url.searchParams.get('secrets') || 'masked');
    const exported = getConfig();
    delete exported.auth;
    if (exported.server) delete exported.server.internalToken;
    if (mode !== 'full') {
      for (const key of ['ai', 'qq', 'tts']) {
        if (exported[key]) exported[key] = maskConfig({ [key]: exported[key] })[key];
      }
    }
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    commonHeaders(res);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="qqbridge-config-${date}.json"`,
      'cache-control': 'no-store',
    });
    return res.end(JSON.stringify(exported, null, 2));
  }

  if (pathname === '/api/import' && method === 'POST') {
    let body;
    try { body = await readJsonBody(req, 2 * 1024 * 1024); }
    catch (error) { return sendError(res, 400, error.message); }
    const imported = body.config && typeof body.config === 'object' ? body.config : body;
    if (!imported || typeof imported !== 'object' || Array.isArray(imported)) return sendError(res, 400, '配置文件格式不正确');
    delete imported.auth;
    if (imported.server) delete imported.server.internalToken;
    backupFile(CONFIG_FILE, 'import_before_');
    try {
      config = saveConfig(applySecretMask(imported, getConfig()), { merge: false });
    } catch (error) {
      return sendError(res, 400, `导入失败：${error.message}`);
    }
    logger.info(`configuration imported by ${ip}`);
    await notifyServicesReload();
    return sendOk(res, maskConfig(config));
  }

  if (pathname === '/api/session' && method === 'GET') {
    return sendOk(res, { token: Boolean(token), mustChangePassword: Boolean(getConfig().auth.mustChange) });
  }

  return sendError(res, 404, '接口不存在');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', 'http://x');
    if (url.pathname === '/healthz') {
      commonHeaders(res);
      return sendJson(res, 200, { ok: true, service: 'admin' });
    }
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    if (url.pathname === '/' || url.pathname === '/admin' || url.pathname === '/admin/' || url.pathname === '/admin/index.html') return serveAdminPage(res);
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    commonHeaders(res);
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  } catch (error) {
    logger.error(`request failed ${req.method} ${req.url}: ${error.stack || error.message}`);
    if (!res.headersSent) sendError(res, error.code === 'LIMIT' ? 413 : 500, error.message || 'server error');
    else try { res.end(); } catch { }
  }
});

server.on('error', error => logger.error(`server error ${error.message}`));
process.on('unhandledRejection', error => logger.error(`unhandledRejection ${error?.message || error}`));
process.on('uncaughtException', error => logger.error(`uncaughtException ${error?.message || error}`));

setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) if (expiry <= now) sessions.delete(token);
  for (const [ip, entry] of loginAttempts) if (entry.reset <= now) loginAttempts.delete(ip);
}, 10 * 60 * 1000);

server.listen(PORT, BIND, () => {
  logger.info(`admin panel listening on ${BIND}:${PORT}`);
  logger.info(`data dir: ${DATA_DIR}`);
  logger.info(`version: ${VERSION}`);
});

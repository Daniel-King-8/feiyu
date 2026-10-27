import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// ---------------------------------------------------------------------------
// 路径常量（容器内固定为 /data；本地联调可用 QQBRIDGE_DATA_DIR 覆盖）
// ---------------------------------------------------------------------------
export const DATA_DIR = path.resolve(process.env.QQBRIDGE_DATA_DIR || '/data');
export const STICKER_DIR = path.join(DATA_DIR, 'stickers');
export const STICKER_MINE_DIR = path.join(STICKER_DIR, 'mine');
export const MEMORY_FILE = path.join(DATA_DIR, 'shared-memory.md');
export const PERSONA_FILE = path.join(DATA_DIR, 'role-card.md');
export const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
export const WEB_HISTORY_FILE = path.join(DATA_DIR, 'web-history.json');
export const IMAGES_DIR = path.join(DATA_DIR, 'images');
export const DRAWN_DIR = path.join(DATA_DIR, 'drawn');
export const BACKUP_DIR = path.join(DATA_DIR, 'backup');
export const LOG_DIR = path.join(DATA_DIR, 'logs');
export const STATE_DIR = path.join(DATA_DIR, 'state');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const TMP = path.resolve(process.env.QQBRIDGE_TMP || '/tmp/qqbridge');
export const VERSION = '1.0.0';

export const DEFAULT_PERSONA = '你是"大肥鱼"，一个俏皮可爱、爱撒娇的小女仆，说话带颜文字。';
export const SECRET_PATHS = ['ai.apiKey', 'qq.accessToken', 'tts.doubao.apiKey'];
export const DEFAULT_LOG_KEEP_DAYS = 7;
export const DEFAULT_LOG_MAX_MB = 5;

export function defaultConfig() {
  return {
    version: 1,
    server: {
      adminPort: 8080,
      webchatPort: 3002,
      bridgeControlPort: 3010,
      bind: '0.0.0.0',
      internalToken: '',
      bridgeUrl: 'http://bridge:3010',
      webchatUrl: 'http://webchat:3002',
    },
    ai: {
      baseUrl: 'https://api.deepseek.com',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 1.15,
      maxTokens: 300,
      timeoutMs: 60000,
    },
    qq: {
      wsUrl: 'ws://napcat:3001',
      accessToken: '',
      selfId: 0,
      allowUins: [],
      allowGroup: false,
      allowGroups: [],
      proactive: {
        enabled: false,
        minGapMs: 90 * 60 * 1000,
        maxPerDay: 8,
        startHour: 8,
        endHour: 23,
        quietAfterChatMs: 20 * 60 * 1000,
      },
    },
    tts: {
      doubao: {
        apiKey: '',
        voiceId: '',
        resource: 'seed-icl-2.0',
        uid: 'dashan',
        instruction: '用甜甜的、温柔的、带点撒娇的语气说',
      },
      edge: {
        enabled: true,
        voice: 'zh-CN-XiaoyiNeural',
        patterns: [['-2%', '+22Hz'], ['+4%', '+28Hz'], ['-5%', '+15Hz'], ['+2%', '+30Hz']],
      },
    },
    draw: {
      sd: { enabled: false, python: 'python3', script: '/app/sd_draw.py', timeoutMs: 240000 },
      pollinations: { enabled: true, width: 768, height: 1024 },
    },
    automation: {
      enabled: false,
      watch: false,
      replyComments: false,
      dynamic: false,
      mention: false,
      cdpUrl: 'http://127.0.0.1:9227',
      contactName: '浪漫给予恋',
    },
    webchat: { historyLimit: 40 },
    auth: { username: 'admin', passwordHash: '', mustChange: false, sessionHours: 24 },
    logs: { keepDays: DEFAULT_LOG_KEEP_DAYS, maxSizeMB: DEFAULT_LOG_MAX_MB },
  };
}

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepClone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

export function deepMerge(base, patch) {
  if (patch === undefined) return deepClone(base);
  if (Array.isArray(patch)) return deepClone(patch);
  if (isPlainObject(patch) && isPlainObject(base)) {
    const out = deepClone(base);
    for (const [key, value] of Object.entries(patch)) {
      out[key] = key in out ? deepMerge(out[key], value) : deepClone(value);
    }
    return out;
  }
  return deepClone(patch);
}

export function getPath(object, dotPath, fallback = undefined) {
  let cursor = object;
  for (const key of String(dotPath).split('.')) {
    if (!isPlainObject(cursor) || !(key in cursor)) return fallback;
    cursor = cursor[key];
  }
  return cursor === undefined ? fallback : cursor;
}

export function setPath(object, dotPath, value) {
  const keys = String(dotPath).split('.');
  let cursor = object;
  for (const key of keys.slice(0, -1)) {
    if (!isPlainObject(cursor[key])) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return object;
}

export function atomicWriteFileSync(file, data) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`);
  let fd;
  try {
    fd = fs.openSync(tmp, 'w');
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmp, file);
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { }
    }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { }
  }
}

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, value) {
  atomicWriteFileSync(file, JSON.stringify(value, null, 2));
}

export function readText(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8'); } catch { return fallback; }
}

export function writeTextAtomic(file, text) {
  atomicWriteFileSync(file, text);
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function ensureDirs() {
  for (const dir of [DATA_DIR, STICKER_DIR, STICKER_MINE_DIR, IMAGES_DIR, DRAWN_DIR, BACKUP_DIR, LOG_DIR, STATE_DIR, TMP]) {
    ensureDir(dir);
  }
  if (!fs.existsSync(PERSONA_FILE)) atomicWriteFileSync(PERSONA_FILE, `${DEFAULT_PERSONA}\n`);
  if (!fs.existsSync(MEMORY_FILE)) atomicWriteFileSync(MEMORY_FILE, '');
}

// 防止路径穿越：只允许解析到 baseDir 内部
export function resolveInside(baseDir, relative) {
  if (typeof relative !== 'string' || !relative) return null;
  const base = path.resolve(baseDir);
  const target = path.resolve(base, relative);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

export function safeFileName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (!trimmed || trimmed === '.' || trimmed === '..') return null;
  if (trimmed.length > 80) return null;
  if (/[\\/:*?"<>|\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

// ---------------------------------------------------------------------------
// 配置读写（带 mtime 缓存）
// ---------------------------------------------------------------------------
let cache = null;
let cacheStamp = '';

export function configStamp() {
  try {
    const stat = fs.statSync(CONFIG_FILE);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return 'missing';
  }
}

function normalizeConfig(raw) {
  const merged = deepMerge(defaultConfig(), isPlainObject(raw) ? raw : {});
  merged.version = 1;
  merged.server.adminPort = toInt(merged.server.adminPort, 8080, 1, 65535);
  merged.server.webchatPort = toInt(merged.server.webchatPort, 3002, 1, 65535);
  merged.server.bridgeControlPort = toInt(merged.server.bridgeControlPort, 3010, 1, 65535);
  merged.ai.temperature = toNumber(merged.ai.temperature, 1.15, 0, 2);
  merged.ai.maxTokens = toInt(merged.ai.maxTokens, 300, 1, 32768);
  merged.ai.timeoutMs = toInt(merged.ai.timeoutMs, 60000, 1000, 300000);
  merged.qq.selfId = toInt(merged.qq.selfId, 0, 0);
  merged.qq.allowUins = normalizeUins(merged.qq.allowUins);
  merged.qq.allowGroups = normalizeUins(merged.qq.allowGroups);
  merged.qq.allowGroup = Boolean(merged.qq.allowGroup);
  merged.qq.proactive.maxPerDay = toInt(merged.qq.proactive.maxPerDay, 8, 0, 100);
  merged.qq.proactive.startHour = toInt(merged.qq.proactive.startHour, 8, 0, 23);
  merged.qq.proactive.endHour = toInt(merged.qq.proactive.endHour, 23, 0, 24);
  merged.webchat.historyLimit = toInt(merged.webchat.historyLimit, 40, 4, 200);
  merged.logs.keepDays = toInt(merged.logs.keepDays, DEFAULT_LOG_KEEP_DAYS, 1, 365);
  merged.logs.maxSizeMB = toNumber(merged.logs.maxSizeMB, DEFAULT_LOG_MAX_MB, 1, 100);
  merged.auth.sessionHours = toInt(merged.auth.sessionHours, 24, 1, 720);
  for (const key of ['watch', 'replyComments', 'dynamic', 'mention']) {
    merged.automation[key] = Boolean(merged.automation[key]);
  }
  merged.automation.enabled = Boolean(merged.automation.enabled);
  merged.tts.edge.enabled = merged.tts.edge.enabled !== false;
  merged.draw.sd.enabled = Boolean(merged.draw.sd.enabled);
  merged.draw.pollinations.enabled = merged.draw.pollinations.enabled !== false;
  return merged;
}

function toInt(value, fallback, min, max = Number.MAX_SAFE_INTEGER) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function toNumber(value, fallback, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeUins(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\s,，;；]+/);
  const out = [];
  for (const item of list) {
    const text = String(item ?? '').trim();
    if (!/^\d{5,12}$/.test(text)) continue;
    const number = Number(text);
    if (!out.includes(number)) out.push(number);
  }
  return out;
}

export function getConfig(force = false) {
  const stamp = configStamp();
  if (force || !cache || stamp !== cacheStamp) {
    cache = normalizeConfig(readJson(CONFIG_FILE, {}));
    cacheStamp = stamp;
  }
  return deepClone(cache);
}

export function reloadConfig() {
  cache = null;
  const config = getConfig(true);
  return config;
}

export function ensureConfigFile() {
  ensureDirs();
  if (!fs.existsSync(CONFIG_FILE)) {
    const config = defaultConfig();
    config.server.internalToken = randomToken(24);
    try {
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { encoding: 'utf8', flag: 'wx' });
      try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  const config = getConfig(true);
  if (!config.server.internalToken) {
    config.server.internalToken = randomToken(24);
    saveConfig(config, { merge: false });
  }
  return config;
}

export function saveConfig(patch, { merge = true } = {}) {
  const current = getConfig(true);
  const nextRaw = merge ? deepMerge(current, patch) : deepMerge(defaultConfig(), patch);
  if (!nextRaw.server?.internalToken) nextRaw.server.internalToken = current.server.internalToken || randomToken(24);
  if (!nextRaw.auth?.passwordHash && current.auth?.passwordHash) nextRaw.auth.passwordHash = current.auth.passwordHash;
  const next = normalizeConfig(nextRaw);
  atomicWriteFileSync(CONFIG_FILE, JSON.stringify(next, null, 2));
  try { fs.chmodSync(CONFIG_FILE, 0o600); } catch { }
  cache = next;
  cacheStamp = configStamp();
  return deepClone(next);
}

export function maskSecret(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.startsWith('sk-')) return `sk-****${text.slice(-4)}`;
  if (text.length <= 6) return '****';
  return `${text.slice(0, 2)}****${text.slice(-4)}`;
}

export function isMasked(value) {
  return typeof value === 'string' && value.includes('****');
}

// 把面板回传的掩码密钥替换回真实值（空字符串代表显式清空）
export function applySecretMask(patch, current) {
  const next = deepClone(patch || {});
  for (const dotPath of SECRET_PATHS) {
    const incoming = getPath(next, dotPath);
    if (typeof incoming === 'string' && isMasked(incoming)) {
      setPath(next, dotPath, getPath(current, dotPath, ''));
    }
  }
  return next;
}

export function maskConfig(config) {
  const out = deepClone(config);
  for (const dotPath of SECRET_PATHS) {
    setPath(out, dotPath, maskSecret(getPath(out, dotPath, '')));
  }
  if (out.server) delete out.server.internalToken;
  if (out.auth) {
    delete out.auth.passwordHash;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 密钥 / API URL
// ---------------------------------------------------------------------------
export function apiKey() {
  const config = getConfig();
  return config.ai.apiKey || process.env.DEEPSEEK_API_KEY || '';
}

export function apiUrl(endpoint) {
  const config = getConfig();
  const base = String(config.ai.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '');
  if (base.endsWith('/chat/completions') && endpoint === '/chat/completions') return base;
  const suffix = endpoint.startsWith('/') ? endpoint : `/${endpoint}`;
  if (base.endsWith(suffix)) return base;
  return `${base}${suffix}`;
}

export function internalToken() {
  return getConfig().server.internalToken;
}

export function automationEnabled(moduleName) {
  const automation = getConfig().automation;
  return Boolean(automation.enabled && automation[moduleName]);
}

// ---------------------------------------------------------------------------
// 密码 / 令牌
// ---------------------------------------------------------------------------
export function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = scryptSync(String(password), salt, 64);
  return `scrypt$16384$8$1$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const actual = scryptSync(String(password), salt, expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024,
    });
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function generatePassword(length = 16) {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let index = 0; index < length; index++) out += alphabet[bytes[index] % alphabet.length];
  return out;
}

// ---------------------------------------------------------------------------
// 日志：按天切分、保留 N 天、单文件 5MB 上限
// ---------------------------------------------------------------------------
const LOG_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

function localDate(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function cleanupLogs(name, keepDays) {
  try {
    const cutoff = Date.now() - keepDays * 24 * 60 * 60 * 1000;
    for (const file of fs.readdirSync(LOG_DIR)) {
      if (!file.startsWith(`${name}-`) || !file.endsWith('.log')) continue;
      const full = path.join(LOG_DIR, file);
      try {
        if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
      } catch { }
    }
  } catch { }
}

export function createLogger(name, { console: toConsole = true } = {}) {
  ensureDir(LOG_DIR);
  const file = path.join(LOG_DIR, `${name}.log`);
  let currentDay = localDate();
  let lastCleanup = 0;

  function rotate(day) {
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 0) {
        fs.renameSync(file, path.join(LOG_DIR, `${name}-${day}.log`));
      }
    } catch { }
  }

  function write(level, message) {
    const now = new Date();
    const today = localDate(now);
    if (today !== currentDay) {
      rotate(currentDay);
      currentDay = today;
    }
    const config = getConfig();
    const maxBytes = Math.max(1, Number(config.logs.maxSizeMB) || DEFAULT_LOG_MAX_MB) * 1024 * 1024;
    try {
      if (fs.existsSync(file) && fs.statSync(file).size >= maxBytes) {
        fs.renameSync(file, path.join(LOG_DIR, `${name}-${today}-${Date.now()}.log`));
      }
    } catch { }
    const line = `[${now.toISOString()}] [${level}] ${message}\n`;
    try { fs.appendFileSync(file, line, 'utf8'); } catch { }
    if (toConsole) console.log(`[${name}] ${message}`);
    if (Date.now() - lastCleanup > LOG_CLEANUP_INTERVAL_MS) {
      lastCleanup = Date.now();
      cleanupLogs(name, Math.max(1, Number(config.logs.keepDays) || DEFAULT_LOG_KEEP_DAYS));
    }
  }

  cleanupLogs(name, Math.max(1, Number(getConfig().logs.keepDays) || DEFAULT_LOG_KEEP_DAYS));
  return {
    file,
    info: message => write('INFO', message),
    warn: message => write('WARN', message),
    error: message => write('ERROR', message),
    log: message => write('INFO', message),
  };
}

export function backupFile(file, prefix = '') {
  try {
    if (!fs.existsSync(file)) return null;
    ensureDir(BACKUP_DIR);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 23);
    const target = path.join(BACKUP_DIR, `${stamp}_${prefix}${path.basename(file)}`);
    fs.copyFileSync(file, target);
    try { fs.chmodSync(target, 0o600); } catch { }
    return target;
  } catch {
    return null;
  }
}

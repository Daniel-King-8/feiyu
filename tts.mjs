import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { getConfig, ensureDir, TMP } from './config.mjs';
import { volcTts } from './volc-tts.mjs';

const FFMPEG = 'ffmpeg';
const PYTHON = 'python3';
const RATE = 24000;

function safeUnlink(file) {
  try { fs.unlinkSync(file); } catch { }
}

/**
 * 豆包 TTS -> edge-tts 降级链。
 * 返回音频文件路径；两条链路都失败时返回 null。
 */
export async function ttsFile(text, { log = () => { }, doubao = {}, cfg } = {}) {
  const config = cfg || getConfig();
  const plain = String(text).replace(/[（(][^）)]*[）)]/g, '').trim().slice(0, 300);

  if (plain && config.tts.doubao.apiKey && config.tts.doubao.voiceId) {
    try {
      const buffer = await volcTts(plain, doubao);
      ensureDir(TMP);
      const out = path.join(TMP, `volc-${Date.now()}.mp3`);
      fs.writeFileSync(out, buffer);
      if (fs.statSync(out).size > 2000) {
        log('volc tts ok');
        return out;
      }
      safeUnlink(out);
    } catch (error) {
      log(`volc tts failed: ${error.message}`);
    }
  }

  if (config.tts.edge.enabled !== false) return edgeTtsFile(text, { log, cfg: config });
  log('tts unavailable: doubao failed and edge-tts disabled');
  return null;
}

export function edgeTtsFile(text, { log = () => { }, cfg } = {}) {
  const config = cfg || getConfig();
  const voice = config.tts.edge.voice || 'zh-CN-XiaoyiNeural';
  const patterns = Array.isArray(config.tts.edge.patterns) && config.tts.edge.patterns.length
    ? config.tts.edge.patterns
    : [['-2%', '+22Hz'], ['+4%', '+28Hz'], ['-5%', '+15Hz'], ['+2%', '+30Hz']];
  const sentences = String(text).split(/(?<=[。！？!?～~…])/).map(item => item.trim()).filter(Boolean).slice(0, 6);
  if (!sentences.length) return null;

  try {
    ensureDir(TMP);
    const files = [];
    sentences.forEach((sentence, index) => {
      const [rate, pitch] = patterns[index % patterns.length];
      const out = path.join(TMP, `s-${Date.now()}-${index}.mp3`);
      try {
        execFileSync(PYTHON, ['-m', 'edge_tts', '--voice', voice, `--rate=${rate}`, `--pitch=${pitch}`, '--text', sentence, '--write-media', out], { timeout: 30000, stdio: 'ignore' });
        if (fs.existsSync(out) && fs.statSync(out).size > 500) files.push(out);
      } catch { }
    });
    if (!files.length) return null;
    if (files.length === 1) return files[0];

    const list = path.join(TMP, `list-${Date.now()}.txt`);
    fs.writeFileSync(list, files.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
    const out = path.join(TMP, `v-${Date.now()}.mp3`);
    try {
      execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-ar', String(RATE), '-ac', '1', out], { timeout: 60000, stdio: 'ignore' });
    } finally {
      safeUnlink(list);
      for (const file of files) safeUnlink(file);
    }
    return fs.existsSync(out) && fs.statSync(out).size > 2000 ? out : null;
  } catch (error) {
    log(`edge tts failed ${error.message}`);
    return null;
  }
}

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { volcTts } from './volc-tts.mjs';
import { TMP } from './config.mjs';

const FFMPEG = 'ffmpeg';
const SING_DIR = path.join(TMP, 'sing');
const RATE = 24000;

// 半音 → 频率倍数
const ratio = semitones => Math.pow(2, semitones / 12);

export async function singWithHerVoice(lyrics, melody, outName = `song-${Date.now()}.mp3`) {
  fs.mkdirSync(SING_DIR, { recursive: true });
  const chars = [...lyrics].filter(ch => ch.trim() && !/[，。！？、,.!?～~]/.test(ch));
  const parts = [];
  for (let index = 0; index < chars.length; index++) {
    const note = melody[index % melody.length];
    const raw = path.join(SING_DIR, `raw-${index}.mp3`);
    const shifted = path.join(SING_DIR, `note-${index}.mp3`);
    try {
      const buffer = await volcTts(chars[index], { instruction: '用唱歌一样的、甜甜的语气' });
      fs.writeFileSync(raw, buffer);
      const factor = ratio(note);
      execFileSync(FFMPEG, [
        '-y', '-i', raw,
        '-filter:a', `asetrate=${Math.round(RATE * factor)},aresample=${RATE},atempo=${(1 / factor).toFixed(4)}`,
        shifted,
      ], { timeout: 30000, stdio: 'ignore' });
      if (fs.existsSync(shifted) && fs.statSync(shifted).size > 500) parts.push(shifted);
    } catch (error) {
      // 单个字失败就跳过
    }
  }
  if (!parts.length) return null;
  const list = path.join(SING_DIR, 'list-her.txt');
  fs.writeFileSync(list, parts.map(file => `file '${file.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8');
  const out = path.join(SING_DIR, outName);
  execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-ar', String(RATE), '-ac', '1', out], { timeout: 60000, stdio: 'ignore' });
  for (const file of parts) { try { fs.unlinkSync(file); } catch { } }
  return fs.existsSync(out) ? out : null;
}

if (process.argv[1]?.endsWith('sing-her.mjs')) {
  const out = await singWithHerVoice('一闪一闪亮晶晶', [0, 0, 7, 7, 9, 9, 7], 'her-song.mp3');
  console.log(out || 'failed');
}

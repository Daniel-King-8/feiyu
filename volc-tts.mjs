import { getConfig } from './config.mjs';

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

export function volcConfig() {
  return getConfig().tts.doubao;
}

// 豆包语音 2.0（X-Api-Key 鉴权，seed-icl-2.0 走复刻音色）
export async function volcTts(text, override = {}) {
  const config = { ...volcConfig(), ...override };
  if (!config?.apiKey || !config?.voiceId) throw new Error('豆包语音配置不完整');

  const resource = config.resource || 'seed-icl-2.0';
  const response = await fetch('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
    method: 'POST',
    headers: {
      'X-Api-Key': config.apiKey,
      'X-Api-Resource-Id': resource,
      'X-Api-Connect-Id': uuid(),
      'X-Api-Request-Id': uuid(),
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      user: { uid: config.uid || 'dashan' },
      req_params: {
        text,
        speaker: config.voiceId,
        instruction: config.instruction ?? '用甜甜的、温柔的、带点撒娇的语气说',
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    }),
  });

  if (!response.ok) throw new Error(`豆包语音 HTTP ${response.status}`);
  const raw = await response.text();
  const chunks = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const item = JSON.parse(trimmed);
      if (item?.code && item.code !== 0) throw new Error(item.message || `code ${item.code}`);
      if (item?.data) chunks.push(item.data);
    } catch (error) {
      if (String(error.message).startsWith('code')) throw error;
    }
  }
  if (!chunks.length) throw new Error('豆包语音没有返回音频');
  return Buffer.from(chunks.join(''), 'base64');
}

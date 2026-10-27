import path from 'node:path';
import {
  createLogger, getConfig, apiKey, apiUrl, readText, writeTextAtomic, ensureDir,
  MEMORY_FILE, DATA_DIR,
} from './config.mjs';

const logger = createLogger('learn');
const DIR = path.join(DATA_DIR, 'learning');
const TOPICS = [
  '三角洲行动 新版本 攻略',
  '绝区零 新角色 玩法',
  '成都周边 一日游 冷门景点',
  '英语口语 日常对话 练习方法',
  'AI 陪伴 为什么让人有情感',
  '怎么把一个小房间布置得舒服',
  '女生 冬季 穿搭 小个子',
  '一个人旅行 安全 注意事项',
];

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
    return blocks.map(block => {
      const raw = block[0];
      const title = clean((raw.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
      const snippet = clean((raw.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [])[1] || '');
      return `${title}：${snippet}`.slice(0, 180);
    }).filter(item => item.length > 15);
  } catch (error) { logger.error(`lookup failed ${error.message}`); return []; }
}

async function main() {
  const config = getConfig();
  const topic = TOPICS[Math.floor(Math.random() * TOPICS.length)];
  const results = await webLookup(topic);
  logger.info(`topic=${topic} results=${results.length}`);
  if (!results.length) return;

  try {
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: '你是大肥鱼，一个住在主人电脑里的女孩。现在是你的自习时间，你刚上网查了点东西，想记下来。写 150-250 字的第一人称学习笔记：像自己琢磨出来的，口语、有好奇心、有一两个具体收获，不要百科腔，不要罗列资料。' },
          { role: 'user', content: `我今天想了解：${topic}\n\n查到的资料：\n${results.join('\n')}` },
        ],
        max_tokens: 500,
        temperature: 1.1,
      }),
    });
    const data = await response.json();
    const note = data?.choices?.[0]?.message?.content?.trim();
    if (!note) { logger.info('empty note'); return; }

    ensureDir(DIR);
    const date = new Date().toISOString().slice(0, 10);
    const file = path.join(DIR, `${date}-${Date.now()}.md`);
    writeTextAtomic(file, `# 自习笔记：${topic}\n\n${note}\n`);
    logger.info(`note saved ${file}`);

    let memory = readText(MEMORY_FILE, '');
    if (!memory.includes('## 我学到的东西')) memory += '\n## 我学到的东西\n';
    memory += `\n### ${date}｜${topic}\n${note}\n`;
    writeTextAtomic(MEMORY_FILE, memory);
    logger.info('memory updated with learning note');
  } catch (error) {
    logger.error(`ERR ${error.message}`);
  }
}

main();

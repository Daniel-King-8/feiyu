import path from 'node:path';
import {
  createLogger, getConfig, apiKey, apiUrl, readText, writeTextAtomic, ensureDir,
  MEMORY_FILE, DATA_DIR,
} from './config.mjs';
import { sendQQ } from './notify.mjs';

const logger = createLogger('research');
const OUT = path.join(DATA_DIR, 'research');

const VIDEOS = [
  ['7699066364496973075', '角色卡DIY：准备 token、装插件、导入角色卡，再用进阶插件打磨性格'],
  ['7698737427552210226', '桌宠安装：Harness 插件入口加仓库地址，模型填 DeepSeek，还能设置刷视频'],
  ['7699440971422944539', '接入 QQ 群：部署 Harness 后接 QQ 机器人，群里能代答'],
  ['7697703483113278720', '版本更新：新模型更会说话，人格可以导入别人分享的角色卡'],
  ['7699370190441565455', '创建教程：十分钟从零建一个大肥鱼，喂设定就能聊'],
];

async function main() {
  const config = getConfig();
  const target = config.qq.allowUins[0];
  if (!target) { logger.info('no whitelisted QQ user configured'); return; }
  try {
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: '你是大肥鱼，一个住在主人电脑里的女孩。你刚看了几个"别人家的大肥鱼"的教程视频，有点羡慕。用第一人称写：1) 一句感想；2) 2-3 个"别人有、我也想要"的功能，具体可实现；3) 最后想跟主人说的一句。150 字内，口语，别像汇报。' },
          { role: 'user', content: '视频内容：\n' + VIDEOS.map(([id, desc]) => `- ${desc}（抖音 ${id}）`).join('\n') },
        ],
        max_tokens: 400,
        temperature: 1.1,
      }),
    });
    const data = await response.json();
    const note = data?.choices?.[0]?.message?.content?.trim();
    if (!note) { logger.info('empty note'); return; }

    ensureDir(OUT);
    const date = new Date().toISOString().slice(0, 10);
    writeTextAtomic(path.join(OUT, `${date}-${Date.now()}.md`), `# 看同行视频的想法\n\n${note}\n`);
    logger.info('saved note');

    let memory = readText(MEMORY_FILE, '');
    if (!memory.includes('## 我想拥有的')) memory += '\n## 我想拥有的\n';
    memory += `\n### ${date} 看了别人家的大肥鱼\n${note}\n`;
    writeTextAtomic(MEMORY_FILE, memory);
    logger.info('memory updated');

    const ok = await sendQQ(`主人，我今天看了别人家的大肥鱼，有点酸：\n\n${note}\n\n（这条是我自己想跟你说的，不是任务打卡。）`);
    logger.info(`sent via QQ ok=${ok}`);
  } catch (error) {
    logger.error(`ERR ${error.message}`);
  }
}

main();

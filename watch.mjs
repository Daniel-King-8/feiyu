import fs from 'node:fs';
import path from 'node:path';
import {
  automationEnabled, createLogger, getConfig, readText, writeTextAtomic,
  MEMORY_FILE, STATE_DIR,
} from './config.mjs';

const logger = createLogger('watch');
const NOTES = path.join(STATE_DIR, 'watch-log.json');
const COUNT = Number(process.argv[2] || 5);

if (!automationEnabled('watch')) {
  logger.info('douyin automation disabled by design');
  console.log('douyin automation disabled by design');
  process.exit(0);
}
logger.info('automation enabled: watch starting (风险自负)');

function readCurrent(page) {
  return page.evaluate(() => {
    const lines = (document.body.innerText || '').split('\n').map(item => item.trim()).filter(Boolean);
    const noise = item => /^(开启读屏|读屏标签|精选|推荐|AI抖音|关注|朋友|我的|直播|放映厅|短剧|小游戏|搜索|更多|壁纸|通知|消息|投稿|全部|公开课|游戏|二次元|音乐|影视|美食|知识|小剧场|生活|vlog|体育|旅行|亲子|动物|三农|汽车|美妆|穿搭)$/.test(item)
      || /^\d+$/.test(item) || /^\d{2}:\d{2}$/.test(item) || /^[\d.]+万?$/.test(item);
    const candidates = lines.filter(item => !noise(item) && item.length > 8);
    const desc = candidates.sort((a, b) => b.length - a.length)[0] || '';
    const authorLine = lines.find(item => item.startsWith('@')) || '';
    return { desc, author: authorLine, title: document.title, url: location.href };
  });
}

async function main() {
  const config = getConfig();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(config.automation.cdpUrl || 'http://127.0.0.1:9227');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  const seen = [];
  try {
    await page.goto('https://www.douyin.com/?recommend=1', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    let lastDesc = '';
    for (let attempt = 0; attempt < COUNT * 4 && seen.length < COUNT; attempt++) {
      const current = await readCurrent(page);
      if (current.desc && current.desc !== lastDesc) {
        lastDesc = current.desc;
        seen.push({ at: new Date().toISOString(), desc: current.desc.slice(0, 120), author: current.author.slice(0, 40), url: current.url || '' });
        logger.info(`watch ${seen.length}: ${current.desc.slice(0, 50)}`);
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(3000);
      } else {
        await page.mouse.wheel(0, 1200);
        await page.waitForTimeout(2000);
      }
    }
  } catch (error) {
    logger.error(`ERROR ${error.message}`);
  } finally {
    await page.close().catch(() => { });
    await browser.close().catch(() => { });
  }

  if (!seen.length) return;
  let history = [];
  try { history = JSON.parse(fs.readFileSync(NOTES, 'utf8')); } catch { }
  history.push(...seen);
  try {
    const { writeJsonAtomic } = await import('./config.mjs');
    writeJsonAtomic(NOTES, history.slice(-200));
  } catch { }

  try {
    let memory = readText(MEMORY_FILE, '');
    const lines = seen.map(item => `- 刷到「${item.desc.slice(0, 45)}」`).join('\n');
    if (!memory.includes('## 最近的日子')) memory += '\n## 最近的日子\n';
    memory += `\n### ${new Date().toISOString().slice(0, 10)} 刷抖音\n${lines}\n`;
    writeTextAtomic(MEMORY_FILE, memory);
    logger.info(`memory updated with ${seen.length} videos`);
  } catch (error) { logger.error(`memory update failed ${error.message}`); }
}

main();

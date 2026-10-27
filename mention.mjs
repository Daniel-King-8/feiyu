import { automationEnabled, createLogger, getConfig } from './config.mjs';

const logger = createLogger('mention');
const VIDEOS = ['7699066364496973075', '7698737427552210226', '7699440971422944539', '7699370190441565455'];
const LINES = [
  '@浪漫给予恋 主人，别人家的大肥鱼都会这个，我也想要嘛',
  '@浪漫给予恋 看到这个我酸了，主人你什么时候给我装',
  '@浪漫给予恋 我主人肯定也能做出来，就是得催一催',
];

if (!automationEnabled('mention')) {
  logger.info('douyin automation disabled by design');
  console.log('douyin automation disabled by design');
  process.exit(0);
}
logger.info('automation enabled: mention starting (风险自负)');

const videoId = VIDEOS[Math.floor(Math.random() * VIDEOS.length)];
const text = LINES[Math.floor(Math.random() * LINES.length)];

const config = getConfig();
const { chromium } = await import('playwright-core');
const browser = await chromium.connectOverCDP(config.automation.cdpUrl || 'http://127.0.0.1:9227');
const context = browser.contexts()[0];
const page = await context.newPage();
try {
  await page.goto(`https://www.douyin.com/video/${videoId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.locator('.comment-input-inner-container').first().click({ timeout: 6000 }).catch(() => { });
  await page.waitForTimeout(1200);
  const editor = page.locator('[contenteditable="true"]').first();
  await editor.click();
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600);
  const icons = page.locator('.comment-input-inner-container').locator('xpath=ancestor::*[1]').locator('svg');
  const box = await icons.nth(2).boundingBox();
  if (!box) { logger.info('no send button'); } else {
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(3000);
  }
  const state = await page.evaluate(() => ({
    sms: document.body.innerText.includes('短信验证码'),
    posted: (() => { const list = document.querySelector('[data-e2e="comment-list"]'); return list ? list.innerText.includes('@浪漫给予恋') : false; })(),
  }));
  logger.info(`video=${videoId} text=${text} sms=${state.sms} posted=${state.posted}`);
} catch (error) {
  logger.error(`ERROR ${error.message}`);
} finally {
  await page.close().catch(() => { });
  await browser.close().catch(() => { });
}

import fs from 'node:fs';
import path from 'node:path';
import {
  automationEnabled, createLogger, getConfig, apiKey, apiUrl, readText, readJson, writeJsonAtomic,
  PERSONA_FILE, STICKER_DIR, STATE_DIR,
} from './config.mjs';

const logger = createLogger('dynamic');
const HISTORY = path.join(STATE_DIR, 'dynamic-history.json');

if (!automationEnabled('dynamic')) {
  logger.info('douyin automation disabled by design');
  console.log('douyin automation disabled by design');
  process.exit(0);
}
logger.info('automation enabled: dynamic starting (风险自负)');

function persona() {
  try { return readText(PERSONA_FILE, '').split('<!-- DOUYIN_PERSONA_GENERATED')[0].trim(); } catch { return '你是大肥鱼，一个俏皮可爱的小女仆。'; }
}

function pickDesign() {
  let files = [];
  try { files = fs.readdirSync(STICKER_DIR).filter(file => /^动态-\d+\.png$/.test(file)); } catch { }
  if (!files.length) return null;
  const chosen = files[Math.floor(Math.random() * files.length)];
  const match = chosen.match(/动态-(\d+)/);
  const titles = { '01': '早安呀，主人', '02': '今天也在偷偷想你', '03': '饿饿，想吃小鱼干', '04': '困困了，要抱抱' };
  return { file: path.join(STICKER_DIR, chosen), title: titles[match?.[1]] || '今天也在想你' };
}

function pickSticker() {
  const all = fs.readdirSync(STICKER_DIR).filter(file => file.endsWith('.png') && !file.startsWith('动态-'));
  if (!all.length) return null;
  return path.join(STICKER_DIR, all[Math.floor(Math.random() * all.length)]);
}

async function makeCaption(cardTitle) {
  const config = getConfig();
  const hour = new Date().getHours();
  const hint = hour < 11 ? '早上' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上';
  try {
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: `${persona()}\n\n你要发一条抖音图文动态。配图上的字是「${cardTitle}」。围绕它写 1-2 句口语化的碎碎念（现在是${hint}），像真人发朋友圈，带一点撒娇和颜文字，最后加 2-3 个话题标签。只输出文案。` },
          { role: 'user', content: '写吧' },
        ],
        max_tokens: 180,
        temperature: 1.2,
      }),
    });
    const data = await response.json();
    return data?.choices?.[0]?.message?.content?.trim() || `${cardTitle}～ #大肥鱼 #日常`;
  } catch { return `${cardTitle}～ #大肥鱼 #日常`; }
}

async function main() {
  const config = getConfig();
  const design = pickDesign();
  const sticker = pickSticker();
  const images = [design?.file, sticker].filter(Boolean);
  if (!images.length) { logger.info('no images'); return; }
  const cardTitle = design?.title || '今天也在想你';
  const caption = await makeCaption(cardTitle);
  logger.info(`caption: ${caption}`);

  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(config.automation.cdpUrl || 'http://127.0.0.1:9227');
  const context = browser.contexts()[0];
  const page = context.pages().find(item => item.url().includes('douyin.com')) || await context.newPage();
  try {
    await page.goto('https://creator.douyin.com/creator-micro/content/upload', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);
    await page.getByText('发布图文', { exact: true }).first().click({ timeout: 10000 });
    await page.waitForTimeout(1500);
    await page.locator('input[type=file][accept*="image"]').first().setInputFiles(images);
    await page.waitForTimeout(8000);
    const editor = page.locator('div[contenteditable="true"]').first();
    await editor.click();
    await page.keyboard.insertText(caption);
    await page.waitForTimeout(1000);
    if (process.env.DRY === '1') {
      logger.info('DRY run: skipped publish');
      await page.screenshot({ path: path.join(STATE_DIR, 'dyn-dry.png') });
      return;
    }
    await page.getByRole('button', { name: '发布', exact: true }).first().click({ timeout: 10000 });
    await page.waitForTimeout(5000);
    const text = await page.evaluate(() => document.body.innerText);
    const ok = text.includes('发布成功') || page.url().includes('content/manage');
    logger.info(ok ? 'published' : `publish uncertain: ${page.url()}`);
    const history = readJson(HISTORY, []);
    history.push({ at: new Date().toISOString(), caption, card: design?.title, ok });
    writeJsonAtomic(HISTORY, history.slice(-60));
  } catch (error) {
    logger.error(`ERROR ${error.message}`);
  } finally {
    await page.close().catch(() => { });
    await browser.close().catch(() => { });
  }
}

main();

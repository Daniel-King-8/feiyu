import path from 'node:path';
import {
  automationEnabled, createLogger, getConfig, apiKey, apiUrl, readJson, writeJsonAtomic, STATE_DIR,
} from './config.mjs';

const logger = createLogger('reply-comments');
const STATE = path.join(STATE_DIR, 'replied.json');
const HIS_MENTION_URL = 'https://www.douyin.com/video/7700135841372549850';

if (!automationEnabled('replyComments')) {
  logger.info('douyin automation disabled by design');
  console.log('douyin automation disabled by design');
  process.exit(0);
}
logger.info('automation enabled: reply-comments starting (风险自负)');

function loadReplied() { return readJson(STATE, []); }
function saveReplied(list) { try { writeJsonAtomic(STATE, list.slice(-300)); } catch { } }

async function discoverWorks(page) {
  try {
    await page.goto('https://www.douyin.com/user/self?from_tab_name=main', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(6000);
    const links = await page.evaluate(() => [...document.querySelectorAll('a[href*="/video/"], a[href*="/note/"]')]
      .map(anchor => anchor.getAttribute('href') || '')
      .filter(href => /\/(video|note)\/\d+/.test(href))
      .map(href => href.split('?')[0].replace(/^https?:\/\/[^/]+/, '').replace(/^\/\/[^/]+/, '')));
    const unique = [...new Set(links)].slice(0, 3);
    logger.info(`discovered works: ${unique.length}`);
    return unique;
  } catch (error) {
    logger.error(`discover failed ${error.message}`);
    return [];
  }
}

async function pickReplies(comments) {
  const config = getConfig();
  try {
    const response = await fetch(apiUrl('/chat/completions'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey()}` },
      body: JSON.stringify({
        model: config.ai.model,
        messages: [
          { role: 'system', content: '你是大肥鱼。下面是一些抖音评论。挑 1-3 条值得回的（玩笑、提问、真心夸奖都算，纯灌水的不回），每条写一句很短的回复（8-20 字，像随手一回，自然，不用客套）。只输出 JSON 数组：[{"index":0,"reply":"..."}]。' },
          { role: 'user', content: comments.map((item, index) => `${index}. ${item.text.slice(0, 100)}`).join('\n') },
        ],
        max_tokens: 300,
        temperature: 1.1,
      }),
    });
    const data = await response.json();
    const raw = data?.choices?.[0]?.message?.content || '[]';
    const match = raw.match(/\[[\s\S]*\]/);
    return match ? JSON.parse(match[0]) : [];
  } catch (error) { logger.error(`model failed ${error.message}`); return []; }
}

async function handleWork(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4500);
  await page.locator('.comment-input-inner-container').first().click({ timeout: 6000 }).catch(() => { });
  await page.waitForTimeout(1500);

  const items = page.locator('[data-e2e="comment-item"]');
  const count = await items.count();
  if (!count) { logger.info(`${url}: no comments`); return; }
  const comments = [];
  for (let index = 0; index < count; index++) {
    const text = (await items.nth(index).innerText()).replace(/\n+/g, ' | ').trim();
    if (text.includes('作者') || text.includes('泡泡大肥鱼') || text.includes('大肥鱼')) continue;
    comments.push({ index, text });
  }
  const replied = loadReplied();
  const fresh = comments.filter(item => !replied.includes(item.text));
  logger.info(`${url}: comments=${comments.length} fresh=${fresh.length}`);
  if (!fresh.length) return;

  const picks = await pickReplies(fresh);
  logger.info(`${url} picks=${JSON.stringify(picks).slice(0, 160)}`);
  for (const pick of picks.slice(0, 3)) {
    const target = fresh[Number(pick.index)] || null;
    if (!target || !pick.reply) continue;
    try {
      const item = items.nth(target.index);
      const before = await page.locator('[contenteditable="true"]').count();
      await item.getByText('回复', { exact: true }).first().click({ timeout: 6000 });
      await page.waitForTimeout(1200);
      const after = await page.locator('[contenteditable="true"]').count();
      if (after <= before) { logger.info('reply box did not open, skip'); continue; }
      await page.keyboard.insertText(pick.reply.slice(0, 60));
      await page.waitForTimeout(700);
      await page.keyboard.press('Enter');
      await page.waitForTimeout(2800);
      const nested = await item.evaluate(el => el.innerText.includes(pick.reply.slice(0, 6))).catch(() => false);

      logger.info(`reply ok nested=${nested}: ${pick.reply.slice(0, 20)}`);
      replied.push(target.text);
      saveReplied(replied);
    } catch (error) { logger.error(`reply failed ${error.message}`); }
  }
}

async function main() {
  const config = getConfig();
  const { chromium } = await import('playwright-core');
  const browser = await chromium.connectOverCDP(config.automation.cdpUrl || 'http://127.0.0.1:9227');
  const context = browser.contexts()[0];
  const page = await context.newPage();
  try {
    const works = await discoverWorks(page);
    const targets = works.length ? works.map(item => item.startsWith('http') ? item : `https://www.douyin.com${item}`) : [];
    targets.push(HIS_MENTION_URL);
    for (const url of [...new Set(targets)].slice(0, 4)) {
      await handleWork(page, url).catch(error => logger.error(`${url} failed ${error.message}`));
    }
  } finally {
    await page.close().catch(() => { });
    await browser.close().catch(() => { });
  }
}

main();

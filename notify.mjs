import WebSocket from 'ws';
import { createLogger, getConfig } from './config.mjs';

const logger = createLogger('notify');

function targetUin() {
  return getConfig().qq.allowUins[0] || 0;
}

export function sendQQ(text, timeoutMs = 12000, targetUser = targetUin()) {
  return new Promise(resolve => {
    if (!targetUser) {
      logger.warn('sendQQ skipped: no whitelisted QQ user configured');
      return resolve(false);
    }
    let settled = false;
    const done = value => { if (!settled) { settled = true; resolve(value); } };
    const config = getConfig();
    const token = config.qq.accessToken;
    const ws = new WebSocket(config.qq.wsUrl, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const echo = `n-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const segments = Array.isArray(text)
      ? text
      : [{ type: 'text', data: { text: String(text ?? '') } }];
    const timer = setTimeout(() => { try { ws.close(); } catch { } done(false); }, timeoutMs);
    ws.on('open', () => {
      ws.send(JSON.stringify({ action: 'send_private_msg', params: { user_id: targetUser, message: segments }, echo }));
    });
    ws.on('message', data => {
      let parsed;
      try { parsed = JSON.parse(String(data)); } catch { return; }
      if (parsed.echo !== echo) return;
      clearTimeout(timer);
      done(parsed.retcode === 0);
      try { ws.close(); } catch { }
    });
    ws.on('error', () => { clearTimeout(timer); done(false); });
  });
}

export async function sendDouyin(text) {
  const automation = getConfig().automation;
  if (!automation.enabled) {
    logger.info('douyin automation disabled by design');
    return false;
  }
  logger.info('automation enabled: douyin notify starting (风险自负)');
  let browser, page;
  try {
    const { chromium } = await import('playwright-core');
    browser = await chromium.connectOverCDP(automation.cdpUrl || 'http://127.0.0.1:9227');
    const context = browser.contexts()[0];
    page = context.pages().find(item => item.url().includes('douyin.com')) || await context.newPage();
    const editor = page.locator('[data-e2e="msg-input"] [contenteditable="true"], .messageEditorinputArea').first();
    if (await editor.count() === 0) {
      await page.locator('[data-e2e="im-entry"]').first().click({ timeout: 8000 }).catch(() => { });
      await page.waitForTimeout(2000);
      if (automation.contactName) {
        const row = page.locator('[data-e2e="im-dialog"]').getByText(automation.contactName).first();
        if (await row.count()) { await row.click({ timeout: 5000 }).catch(() => { }); await page.waitForTimeout(1500); }
      }
    }
    if (await editor.count() === 0) { logger.info('douyin send: no editor'); return false; }
    await editor.click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.keyboard.insertText(String(text).slice(0, 400));
    await page.waitForTimeout(500);
    const icons = page.locator('[data-e2e="msg-input"] svg');
    const box = await icons.nth((await icons.count()) - 1).boundingBox();
    if (!box) { logger.info('douyin send: no send button'); return false; }
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(2000);
    logger.info('douyin send ok');
    return true;
  } catch (error) {
    logger.error(`douyin send failed ${error.message}`);
    return false;
  } finally {
    await page?.close().catch(() => { });
    await browser?.close().catch(() => { });
  }
}

export async function notify(text) {
  const viaQQ = await sendQQ(text);
  if (viaQQ) { logger.info(`sent via QQ: ${String(text).slice(0, 40)}`); return 'qq'; }
  const viaDy = await sendDouyin(text);
  logger.info(`qq failed, douyin=${viaDy}: ${String(text).slice(0, 40)}`);
  return viaDy ? 'douyin' : 'none';
}

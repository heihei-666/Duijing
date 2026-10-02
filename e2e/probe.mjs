import { chromium } from 'playwright';

import { BASE, requireInvite, TEST_PASSWORD, SHOTS, OUT } from './config.mjs';
const USER = `probe${Date.now().toString().slice(-8)}`;
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage','--disable-gpu','--single-process'], timeout: 120000 });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const page = await ctx.newPage();

await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.fill('input[name="invite_code"]', requireInvite());
await page.click('button[type="submit"]');
await page.waitForURL(u => !u.pathname.includes('register'), { timeout: 30000 });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1500);
console.log('  已登录，URL:', page.url());

console.log('\n  ══ 首页所有 button ══');
for (const [i, b] of (await page.locator('button').all()).entries()) {
  const t = ((await b.textContent()) || '').replace(/\s+/g,' ').trim();
  const al = await b.getAttribute('aria-label');
  const vis = await b.isVisible();
  console.log(`    [${i}] visible=${vis} aria="${al||''}" text="${t.slice(0,42)}"`);
}
console.log('\n  ══ 是否有 dialog 打开 ══');
console.log('    [role=dialog] 数量:', await page.locator('[role="dialog"]').count());

console.log('\n  ══ 首页可见文本（前 500）══');
console.log('   ', (await page.textContent('body')||'').replace(/\s+/g,' ').trim().slice(0,500));
await page.screenshot({ path: `${SHOTS}/probe-home.png`, fullPage: true });
await browser.close();

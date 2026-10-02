import { chromium } from 'playwright';

import { BASE, requireInvite, TEST_PASSWORD, SHOTS, OUT } from './config.mjs';
const browser = await chromium.launch({ args: ['--no-sandbox','--disable-dev-shm-usage'] });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'zh-CN' });
const page = await ctx.newPage();
page.on('pageerror', e => console.log('  PAGEERROR:', e.message.slice(0,150)));
page.on('console', m => { if (m.type()==='error') console.log('  CONSOLE-ERR:', m.text().slice(0,150)); });

await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
console.log('  URL:', page.url());
console.log('  TITLE:', await page.title());
await page.screenshot({ path: `${SHOTS}/00-register.png`, fullPage: true });

console.log('\n  ── 表单元素 ──');
const inputs = await page.locator('input').all();
for (const [i, el] of inputs.entries()) {
  console.log(`    input[${i}] name=${await el.getAttribute('name')} type=${await el.getAttribute('type')} placeholder=${await el.getAttribute('placeholder')} id=${await el.getAttribute('id')}`);
}
const buttons = await page.locator('button').all();
for (const [i, el] of buttons.entries()) {
  console.log(`    button[${i}] type=${await el.getAttribute('type')} text="${(await el.textContent()||'').trim().slice(0,30)}"`);
}
console.log('\n  ── 页面可见文本（前 600 字）──');
console.log('   ', (await page.textContent('body') || '').replace(/\s+/g,' ').trim().slice(0, 600));
await browser.close();

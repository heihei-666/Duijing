/**
 * 横向溢出探针。
 *
 * 移动端最常见的隐性布局事故：某个元素比视口宽，整页可以左右晃，
 * 用户会把「点不到按钮」误报成「按钮不存在」。这个脚本直接量出来，
 * 并且列出到底是哪个元素越界，省得靠肉眼看截图猜。
 *
 * 用法：
 *   node e2e/overflow-probe.mjs /debates/2
 *   node e2e/overflow-probe.mjs /weaknesses --width 1280 --height 900
 *
 * 需要登录的页面：设 DJ_USER / DJ_PASSWORD（见 e2e/README.md）。
 */
import { chromium } from 'playwright';

import { BASE, CHROME_ARGS, MOBILE_VIEWPORT, TEST_PASSWORD } from './config.mjs';

const path = process.argv[2];
if (!path) {
  console.error('\n  用法：node e2e/overflow-probe.mjs <路径> [--width N] [--height N]\n');
  process.exit(2);
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};
const width = arg('width', MOBILE_VIEWPORT.width);
const height = arg('height', MOBILE_VIEWPORT.height);

const USER = process.env.DJ_USER ?? '';
const PASSWORD = process.env.DJ_PASSWORD ?? TEST_PASSWORD;

const browser = await chromium.launch({ args: CHROME_ARGS, timeout: 120000 });
const ctx = await browser.newContext({ viewport: { width, height }, locale: 'zh-CN' });
const page = await ctx.newPage();

if (USER) {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('login'), { timeout: 30000 });
  console.log(`  已用 ${USER} 登录`);
}

await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 60000 });
await page.waitForTimeout(2000);

const result = await page.evaluate(() => {
  const de = document.documentElement;
  const overflowers = [];
  for (const el of document.querySelectorAll('*')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0) continue;
    if (rect.right > window.innerWidth + 1 || rect.left < -1) {
      overflowers.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.className || '').toString().slice(0, 70),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
        text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40),
      });
    }
  }
  return {
    innerWidth: window.innerWidth,
    docScrollWidth: de.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    overflowers: overflowers.slice(0, 10),
  };
});

console.log(`\n  ══ ${path} @ ${width}×${height} ══`);
console.log(
  `    innerWidth=${result.innerWidth} docScrollWidth=${result.docScrollWidth} bodyScrollWidth=${result.bodyScrollWidth}`,
);
console.log(`    横向溢出：${result.docScrollWidth > result.innerWidth ? '❌ 有' : '✅ 无'}`);
for (const o of result.overflowers) {
  console.log(`      · <${o.tag}> [${o.left}..${o.right}] "${o.text}" cls=${o.cls}`);
}

await browser.close();
process.exit(result.docScrollWidth > result.innerWidth ? 1 : 0);

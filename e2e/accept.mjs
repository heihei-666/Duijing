import { chromium } from 'playwright';

import { BASE, requireInvite, TEST_PASSWORD, SHOTS, OUT } from './config.mjs';
import fs from 'node:fs';

const USER = `cold${Date.now().toString().slice(-8)}`;
const INVITE = requireInvite();
const log = (...a) => console.log('  ' + a.join(' '));
const R = { testUser: USER };

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  timeout: 120000,
});
// 全新上下文 = 无痕：独立 storage、无 Cookie、无缓存
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(`console: ${m.text().slice(0, 140)}`); });

const startBtn = () => page.getByRole('button', { name: '开始', exact: true });
const recordBtn = () => page.getByRole('button', { name: '记一笔', exact: true });

// ── ① 无痕注册 ──
log('① 无痕环境下注册全新账号…');
await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.fill('input[name="invite_code"]', INVITE);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes('register'), { timeout: 30000 });
await page.waitForLoadState('networkidle');
log(`   ✅ 注册成功：${USER}`);

// ── ② 测量「多久出现可点的行动」 ──
const t0 = Date.now();
let tActionable = null;
for (let i = 0; i < 100; i += 1) {
  const a = await startBtn().isVisible().catch(() => false);
  const b = await recordBtn().isVisible().catch(() => false);
  if (a && b) { tActionable = Date.now() - t0; break; }
  await page.waitForTimeout(50);
}
R.timeToActionableMs = tActionable;
log(`② 首页两个行动按钮可见耗时：${tActionable}ms（验收线 3000ms）`);
await page.screenshot({ path: `${SHOTS}/01-home-empty.png`, fullPage: true });

const homeText = await page.textContent('body');
R.copyDebate = homeText.includes('想不想来一次 3 分钟的即兴辩论');
R.copyRecord = homeText.includes('记录一个你今天不爽的瞬间');
log(`   卡片一文案 ${R.copyDebate ? '✅' : '❌'}　卡片二文案 ${R.copyRecord ? '✅' : '❌'}`);

// ── ③ 即兴辩论：1 次点击开面板 + 1 次点击选立场 = 开始 ──
log('③ 点「开始」→ 选立场 → 进辩论房');
const clickT0 = Date.now();
await startBtn().click();
await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/02-quick-debate-sheet.png`, fullPage: true });

const sheetText = await page.textContent('[role="dialog"]');
R.sheetText = sheetText.replace(/\s+/g, ' ').trim().slice(0, 200);
log(`   面板内容：${R.sheetText.slice(0, 90)}…`);

// 面板内所有按钮
const sheetBtns = [];
for (const b of await page.locator('[role="dialog"] button').all()) {
  const t = ((await b.textContent()) || '').trim();
  const al = await b.getAttribute('aria-label');
  if (await b.isVisible()) sheetBtns.push({ el: b, text: t, aria: al });
}
R.sheetButtons = sheetBtns.map((b) => b.text || `(${b.aria})`);
log(`   面板按钮：${JSON.stringify(R.sheetButtons)}`);

// 立场按钮 = 有文字、非「换一题/取消/关闭」
const stance = sheetBtns.find((b) => b.text && !/换一题|取消|关闭|完成/.test(b.text));
R.stanceChosen = stance.text;
await stance.el.click();
await page.waitForURL(/\/debates\/\d+/, { timeout: 90000 });
R.roomUrl = page.url();
R.twoClicksToDebateMs = Date.now() - clickT0;
log(`   ✅ 选了「${R.stanceChosen}」，进入 ${R.roomUrl}（共 ${R.twoClicksToDebateMs}ms）`);

// 等房间真正渲染完：出现轮次指示这个只有拿到数据后才会渲染的标记。
//
// 正则必须覆盖 RoomHeader.roundLabel() 的全部形态，只写「共 N 轮」会漏掉
// 「开场 · 计划 N 轮」——那正是刚建好房间时的状态，于是每次都白等满 30 秒超时。
const ROUND_LABEL = /(第\s*\d+\s*轮|共\s*\d+\s*轮|计划\s*\d+\s*轮|已结束)/;
await page.waitForFunction(
  (src) => new RegExp(src).test(document.body.innerText || ''),
  ROUND_LABEL.source,
  { timeout: 30000 },
).catch(() => {});
await page.waitForTimeout(800);
await page.screenshot({ path: `${SHOTS}/03-debate-room.png`, fullPage: true });
const roomText = (await page.textContent('body')) || '';
R.roomChars = roomText.length;
R.aiOpening = roomText.includes('AI') && (roomText.includes('开场') || roomText.includes('开场白'));
// ⚠️ 这两个字段此前**被读取却从未赋值**，所以那两行日志永远打印 ❌ ——
// 一个稳定的假阴性，而且因为看起来「只是没通过」很容易被忽略。现在真的去查。
R.roomHasInput = (await page.locator('textarea').count()) > 0;
R.roomHasRounds = ROUND_LABEL.test(roomText);
log(`   辩论房：AI 开场白 ${R.aiOpening ? '✅' : '❌'}　输入区 ${R.roomHasInput ? '✅' : '❌'}　轮次指示 ${R.roomHasRounds ? '✅' : '❌'}`);

// ── ④ 第二条路径：记一笔 ──
log('④ 回首页点「记一笔」记录一个瞬间');
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await recordBtn().click();
await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
await page.waitForTimeout(600);
await page.screenshot({ path: `${SHOTS}/04-quick-record-sheet.png`, fullPage: true });

const ta = page.locator('[role="dialog"] textarea').first();
await ta.fill('开会时被同事打断，当时没说什么，事后有点憋屈');
await page.waitForTimeout(200);
const saveBtn = page.locator('[role="dialog"] button').filter({ hasText: /^保存$/ }).first();
await saveBtn.click();
await page.waitForTimeout(3000);
await page.screenshot({ path: `${SHOTS}/05-after-record.png`, fullPage: true });
const after = (await page.textContent('body')) || '';
R.recordConfirmed = /记下了|AI 稍后/.test(after);
log(`   保存后温和确认：${R.recordConfirmed ? '✅' : '❌'}`);

// ── ⑤ 数据是否真的落库 + 首页空状态是否变化 ──
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${SHOTS}/06-home-after.png`, fullPage: true });
R.jsErrors = errors;
await browser.close();
fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(R, null, 2));

console.log('\n══════ 验收结果 ══════');
for (const [k, v] of Object.entries(R)) console.log(`  ${k}: ${JSON.stringify(v)}`);

import { chromium } from 'playwright';

import { BASE, requireInvite, TEST_PASSWORD, SHOTS, OUT } from './config.mjs';
import fs from 'node:fs';

const INVITE = requireInvite();
const USER = `fresh${Date.now().toString().slice(-8)}`;
const log = (...a) => console.log('  ' + a.join(' '));
const R = { testUser: USER };

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  timeout: 120000,
});
// 无痕上下文
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 140)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text().slice(0, 120)); });

const hasText = async (t) => (await page.textContent('body') || '').includes(t);
const btnVisible = (name) => page.getByRole('button', { name, exact: true }).isVisible().catch(() => false);

// ── 注册全新账号 ──
await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.fill('input[name="invite_code"]', INVITE);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes('register'), { timeout: 30000 });
await page.waitForLoadState('networkidle');
await page.waitForTimeout(1200);
log(`注册成功：${USER}`);

// ── 验收 1：全新账号，底部干净 ──
log('');
log('【验收 1】全新账号的首页');
R.fresh_startBtn = await btnVisible('开始');
R.fresh_recordBtn = await btnVisible('记一笔');
R.fresh_bottomDebate = await btnVisible('和 AI 辩一轮');
R.fresh_bottomRecord = await btnVisible('+ 记一笔');
R.fresh_tagline = await hasText('这是你的第一站');

log(`  卡片内「开始」        ${R.fresh_startBtn ? '✅ 可见' : '❌'}`);
log(`  卡片内「记一笔」      ${R.fresh_recordBtn ? '✅ 可见' : '❌'}`);
log(`  底部「和 AI 辩一轮」  ${R.fresh_bottomDebate ? '❌ 仍然可见' : '✅ 已隐藏'}`);
log(`  底部「+ 记一笔」      ${R.fresh_bottomRecord ? '❌ 仍然可见' : '✅ 已隐藏'}`);
log(`  「这是你的第一站」    ${R.fresh_tagline ? '✅ 出现' : '❌ 缺失'}`);
await page.screenshot({ path: `${SHOTS}/f1-fresh-home.png`, fullPage: true });

// ── 验收 2a：记一笔事件卡 → 刷新 → 底部按钮回来 ──
log('');
log('【验收 2a】记一笔事件卡后刷新');
await page.getByRole('button', { name: '记一笔', exact: true }).click();
await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
await page.waitForTimeout(500);
await page.locator('[role="dialog"] textarea').first().fill('开会时被同事打断，当时没说什么');
await page.locator('[role="dialog"] button').filter({ hasText: /^保存$/ }).first().click();
await page.waitForTimeout(2500);
// 关掉 Sheet（若有「完成」按钮）
const done = page.locator('[role="dialog"] button').filter({ hasText: /^完成$/ }).first();
if (await done.isVisible().catch(() => false)) await done.click();
await page.waitForTimeout(500);

await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
R.afterCard_bottomDebate = await btnVisible('和 AI 辩一轮');
R.afterCard_bottomRecord = await btnVisible('+ 记一笔');
R.afterCard_tagline = await hasText('这是你的第一站');
log(`  底部「和 AI 辩一轮」  ${R.afterCard_bottomDebate ? '✅ 已恢复' : '❌ 仍隐藏'}`);
log(`  底部「+ 记一笔」      ${R.afterCard_bottomRecord ? '✅ 已恢复' : '❌ 仍隐藏'}`);
log(`  「这是你的第一站」    ${R.afterCard_tagline ? '❌ 仍在' : '✅ 已消失'}`);
log(`  （两张卡片此时仍为空：${!(await hasText('想不想来一次')) ? '是' : '否'}——正是判定逻辑的关键）`);
await page.screenshot({ path: `${SHOTS}/f2-after-eventcard.png`, fullPage: true });

// ── 验收 2b：建一条回环 → 刷新 → 底部按钮仍在 ──
log('');
log('【验收 2b】再建一条回环后刷新');
const wid = await page.evaluate(async () => {
  const r = await fetch('/api/weaknesses', {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: '被追问时防御性重复', description: '重复原话不给新证据', domains: ['work'], confidence: 3 }),
  });
  const j = await r.json();
  if (!j.weakness) return null;
  await fetch(`/api/weaknesses/${j.weakness.id}/loops`, {
    method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mode: 'form', trigger_scene: '开会被追问', action_plan: '先说没想清楚再补事实', activate: true }),
  });
  return j.weakness.id;
});
R.weaknessId = wid;
await page.reload({ waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
R.afterLoop_bottomDebate = await btnVisible('和 AI 辩一轮');
R.afterLoop_cardGone = !(await hasText('想不想来一次'));
R.afterLoop_showsLoop = await hasText('被追问时防御性重复') || await hasText('先说没想清楚');
log(`  卡片一已显示真实内容  ${R.afterLoop_showsLoop ? '✅' : '❌'}`);
log(`  空状态引导已消失      ${R.afterLoop_cardGone ? '✅' : '❌'}`);
log(`  底部「和 AI 辩一轮」  ${R.afterLoop_bottomDebate ? '✅ 可见' : '❌'}`);
await page.screenshot({ path: `${SHOTS}/f3-after-loop.png`, fullPage: true });

R.jsErrors = errors;
await browser.close();
fs.writeFileSync(`${OUT}/fresh-result.json`, JSON.stringify(R, null, 2));
console.log('\n══════ 结果 ══════');
for (const [k, v] of Object.entries(R)) console.log(`  ${k}: ${JSON.stringify(v)}`);

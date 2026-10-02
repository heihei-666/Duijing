import { chromium } from 'playwright';

import { BASE, requireInvite, TEST_PASSWORD, SHOTS, OUT } from './config.mjs';
import fs from 'node:fs';

const INVITE = requireInvite();
const USER = `gap${Date.now().toString().slice(-8)}`;
const log = (...a) => console.log('  ' + a.join(' '));
const R = { testUser: USER };

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  timeout: 120000,
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message.slice(0, 150)));
page.on('console', (m) => { if (m.type() === 'error' && !m.text().includes('401')) errors.push(m.text().slice(0, 130)); });

// ── 注册并造数据 ──
await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
await page.fill('input[name="username"]', USER);
await page.fill('input[name="password"]', TEST_PASSWORD);
await page.fill('input[name="invite_code"]', INVITE);
await page.click('button[type="submit"]');
await page.waitForURL((u) => !u.pathname.includes('register'), { timeout: 30000 });
log(`注册成功：${USER}`);

const seeded = await page.evaluate(async () => {
  const H = { 'Content-Type': 'application/json' };
  const post = async (url, body) => (await fetch(url, { method: 'POST', credentials: 'include', headers: H, body: JSON.stringify(body) })).json();
  const w = await post('/api/weaknesses', { name: '被追问时防御性重复', description: '重复原话不给新证据', domains: ['work'], confidence: 4 });
  const w2 = await post('/api/weaknesses', { name: '计划外变化容易焦躁', description: '方案被打乱时反应大', domains: ['emotion'], confidence: 3 });
  const lp = await post(`/api/weaknesses/${w.weakness.id}/loops`, { mode: 'form', trigger_scene: '开会被追问进度', action_plan: '先说没想清楚再补事实', activate: true });
  await post('/api/event-cards', { content: '开会时被同事打断，当时没说什么' });
  return { wid: w.weakness.id, wid2: w2.weakness.id, loopId: lp.loop.id };
});
R.seeded = seeded;

// ── ① 辩论页：四来源面板 ──
log('');
log('【①】辩论页的来源选择面板');
await page.goto(`${BASE}/debates`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.getByRole('button', { name: /开一场新的辩论/ }).click();
await page.waitForSelector('[role="dialog"]', { timeout: 15000 });
await page.waitForTimeout(1200);
const sheet = (await page.textContent('[role="dialog"]')) || '';
R.src_hasLoop = sheet.includes('从回环起辩');
R.src_hasCard = sheet.includes('刚发生的事');
R.src_hasScene = sheet.includes('描述场景');
R.src_hasManual = sheet.includes('自己出题');
log(`  四个来源分段：回环 ${R.src_hasLoop?'✅':'❌'}　事件卡 ${R.src_hasCard?'✅':'❌'}　场景 ${R.src_hasScene?'✅':'❌'}　自己出题 ${R.src_hasManual?'✅':'❌'}`);
await page.screenshot({ path: `${SHOTS}/g1-source-sheet.png`, fullPage: true });
await page.keyboard.press('Escape');
await page.waitForTimeout(600);

// ── ② 弱点墙：宽屏黑板 ──
log('');
log('【②】弱点墙宽屏黑板（1280px）');
await page.goto(`${BASE}/weaknesses`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const board = (await page.textContent('body')) || '';
R.board_hasLabel = board.includes('弱点黑板') || board.includes('垃圾桶');
R.board_hasZones = ['观察中', '改善中'].every((t) => board.includes(t));
R.board_noLongPress = !board.includes('长按');
const hasDnd = await page.locator('[data-board-note], [role="button"][aria-roledescription]').count();
R.board_draggables = hasDnd;
log(`  黑板标识 ${R.board_hasLabel?'✅':'❌'}　三区 ${R.board_hasZones?'✅':'❌'}　可拖元素 ${hasDnd} 个`);
await page.screenshot({ path: `${SHOTS}/g2-board-wide.png`, fullPage: true });

// ── ③ 弱点详情：用辩论练这个 ──
log('');
log('【③】弱点详情页的「用辩论练这个」');
await page.goto(`${BASE}/weaknesses/${seeded.wid}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const detail = (await page.textContent('body')) || '';
R.detail_hasButton = detail.includes('用辩论练这个');
log(`  按钮存在：${R.detail_hasButton ? '✅' : '❌'}`);
await page.screenshot({ path: `${SHOTS}/g3-weakness-detail.png`, fullPage: true });

// ── ④ 资产页：已归档段 ──
log('');
log('【④】资产页的「已归档」');
await page.goto(`${BASE}/assets?tab=advantages`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1800);
const assets = (await page.textContent('body')) || '';
R.assets_hasArchived = assets.includes('已归档');
log(`  「已归档」段存在：${R.assets_hasArchived ? '✅' : '❌'}`);
await page.screenshot({ path: `${SHOTS}/g4-assets.png`, fullPage: true });

// ── ⑤ 窄屏不应出现黑板 ──
log('');
log('【⑤】窄屏（390px）应仍是列表态');
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/weaknesses`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
const narrow = (await page.textContent('body')) || '';
R.narrow_noBoard = !narrow.includes('弱点黑板');
R.narrow_hasList = ['AI 观察候选', '观察中', '改善中', '暂存'].some((t) => narrow.includes(t));
log(`  无黑板 ${R.narrow_noBoard?'✅':'❌'}　有列表分区 ${R.narrow_hasList?'✅':'❌'}`);
await page.screenshot({ path: `${SHOTS}/g5-board-narrow.png`, fullPage: true });

R.jsErrors = errors;
await browser.close();
fs.writeFileSync(`${OUT}/gaps-result.json`, JSON.stringify(R, null, 2));
console.log('\n══════ 结果 ══════');
for (const [k, v] of Object.entries(R)) console.log(`  ${k}: ${JSON.stringify(v)}`);

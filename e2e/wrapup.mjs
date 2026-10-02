/**
 * 验收：辩满（并超出）计划轮数后，「结束并复盘」必须**够得着**。
 *
 * 背景：用户房间 current_round=8 / max_rounds=4，底部提示写着
 * 「可以点『结束并复盘』」，但那个按钮在消息列表顶部，隔着十几条消息，
 * 手机上好几屏之外 —— 用户报告「好像没有对应的按钮或者其他可操作的」。
 *
 * 这个脚本在**生产环境**复现同构状态（复制用户房间的辩题与全部消息），
 * 然后检查：
 *   ① 提示条与它自带的「结束并复盘」按钮都在**首屏视口内**（不需要滚动）
 *   ② 顶栏轮次如实写成「第 8 轮 / 计划 4 轮」，不是「第 8 轮 / 共 4 轮」
 *   ③ 按钮真的能点、点了真的出复盘卡片
 *   ④ 刷新后提示与按钮仍然在（旧实现靠 SSE 事件 setNotice，刷新即消失）
 */
import { chromium } from 'playwright';

import { BASE, requireInvite, TEST_PASSWORD, SHOTS, OUT } from './config.mjs';
import { execSync } from 'node:child_process';

const USER = `wrap${Date.now().toString().slice(-8)}`;
const PASS = TEST_PASSWORD;
const INVITE = requireInvite();
const SSH = process.env.DJ_SSH ?? '';
const DB = process.env.DJ_DB ?? '/opt/duijing/data/duijing.db';

if (!SSH) {
  console.error('\n  ✗ 这个脚本需要 DJ_SSH 才能复刻房间状态。用法见 e2e/README.md。\n');
  process.exit(2);
}

const sql = (q) =>
  execSync(`${SSH} ${JSON.stringify(`echo ${Buffer.from(q, 'utf8').toString('base64')} | base64 -d | sudo sqlite3 ${DB}`)}`)
    .toString()
    .trim();

const log = (...a) => console.log('  ' + a.join(' '));
const R = { testUser: USER, checks: [] };
const check = (name, pass, detail = '') => {
  R.checks.push({ name, pass, detail });
  log(`${pass ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({
  args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--single-process'],
  timeout: 120000,
});
const ctx = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 2,
  locale: 'zh-CN',
});
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message.slice(0, 160)}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !m.text().includes('401')) errors.push(`console: ${m.text().slice(0, 140)}`);
});

/** 元素是否真的落在首屏视口内（Playwright 的 isVisible 不管这个） */
async function inViewport(locator) {
  const box = await locator.boundingBox();
  if (!box) return { ok: false, box: null };
  const vh = page.viewportSize().height;
  const vw = page.viewportSize().width;
  const ok =
    box.y >= -1 && box.y + box.height <= vh + 1 && box.x >= -1 && box.x + box.width <= vw + 1;
  return { ok, box, vh };
}

try {
  /* ── ① 注册测试账号 ── */
  log(`① 注册测试账号 ${USER} …`);
  await page.goto(`${BASE}/register`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.fill('input[name="username"]', USER);
  await page.fill('input[name="password"]', PASS);
  await page.fill('input[name="invite_code"]', INVITE);
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.includes('register'), { timeout: 30000 });
  await page.waitForLoadState('networkidle');
  const uid = sql(`SELECT id FROM user WHERE username='${USER}'`);
  log(`   ✅ 注册成功，user_id=${uid}`);

  /* ── ② 复刻同构房间：辩题、立场、全部 17 条消息照搬，轮次 8 / 计划 4 ── */
  log('② 复刻「第 8 轮 / 计划 4 轮」房间 …');
  sql(
    `INSERT INTO debate_room (user_id, topic, stance, status, max_rounds, current_round, source_type, source_id, loop_id, weakness_id, invite_token, created_at, finished_at)
     SELECT ${uid}, topic, stance, 'active', 4, 8, 'manual', NULL, NULL, NULL, NULL, created_at, NULL FROM debate_room WHERE id=2;`,
  );
  const roomId = sql(`SELECT id FROM debate_room WHERE user_id=${uid} ORDER BY id DESC LIMIT 1`);
  sql(
    `INSERT INTO debate_message (room_id, role, user_id, content, round, seq, abandoned, created_at)
     SELECT ${roomId}, role, CASE WHEN role='user' THEN ${uid} ELSE NULL END, content, round, seq, abandoned, created_at
     FROM debate_message WHERE room_id=2;`,
  );
  const n = sql(`SELECT count(*) FROM debate_message WHERE room_id=${roomId}`);
  log(`   ✅ room_id=${roomId}，消息 ${n} 条`);

  /* ── ③ 打开房间，停在底部 ── */
  log('③ 打开辩论房（页面会自动滚到底部，模拟用户刚辩完一轮）…');
  await page.goto(`${BASE}/debates/${roomId}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(1800);

  /* ── ④ 顶栏轮次必须诚实 ── */
  const headerText = (await page.textContent('body')).replace(/\s+/g, ' ');
  check(
    '顶栏轮次如实写「第 8 轮 / 计划 4 轮」',
    headerText.includes('第 8 轮 / 计划 4 轮'),
    headerText.includes('第 8 轮 / 共 4 轮') ? '仍是自相矛盾的「第 8 轮 / 共 4 轮」' : '',
  );

  /* ── ⑤ 至少一个「结束并复盘」必须落在首屏视口内 ── */
  /** 房间里有几个「结束并复盘」，返回各自是否在首屏视口内 */
  async function probeFinishButtons() {
    const loc = page.getByRole('button', { name: '结束并复盘', exact: true });
    const total = await loc.count();
    const rows = [];
    for (let i = 0; i < total; i += 1) rows.push(await inViewport(loc.nth(i)));
    return { loc, total, rows };
  }

  const noticeSeen = headerText.includes('已经辩了 8 轮') && headerText.includes('比计划的 4 轮多 4 轮');
  check('底部提示如实报「已经辩了 8 轮，比计划的 4 轮多 4 轮」', noticeSeen);

  let probe = await probeFinishButtons();
  check('「结束并复盘」按钮存在', probe.total >= 1, `共 ${probe.total} 个（顶部操作行 + 底部提示条）`);

  const hitIdx = probe.rows.findIndex((r) => r.ok);
  check(
    '其中至少一个就在首屏视口内，不需要滚动',
    hitIdx >= 0,
    hitIdx >= 0
      ? `第 ${hitIdx + 1} 个：y=${Math.round(probe.rows[hitIdx].box.y)} 视口高=${probe.rows[hitIdx].vh}`
      : probe.rows.map((r) => (r.box ? `y=${Math.round(r.box.y)}` : 'null')).join(' / '),
  );

  await page.screenshot({ path: `${SHOTS}/wrapup-01-visible.png`, fullPage: false });
  await page.screenshot({ path: `${SHOTS}/wrapup-01-full.png`, fullPage: true });

  /* ── ⑥ 刷新后仍在（旧实现靠 SSE 事件 setNotice，刷新即丢） ── */
  log('④ 刷新页面，检查提示与按钮是否仍然在 …');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForTimeout(1800);
  probe = await probeFinishButtons();
  const hitIdx2 = probe.rows.findIndex((r) => r.ok);
  check(
    '刷新后按钮仍在视口内（不再依赖 SSE 事件）',
    probe.total >= 1 && hitIdx2 >= 0,
    `共 ${probe.total} 个，视口内 ${hitIdx2 >= 0 ? `第 ${hitIdx2 + 1} 个` : '无'}`,
  );

  /* ── ⑦ 点它，必须真的出复盘 ── */
  log('⑤ 点视口内的那个「结束并复盘」，等复盘卡片 …');
  const t0 = Date.now();
  await probe.loc.nth(hitIdx2 >= 0 ? hitIdx2 : 0).click();
  let reviewed = false;
  try {
    await page.waitForFunction(
      () => document.body.innerText.includes('如果再来一次'),
      undefined,
      { timeout: 90000 },
    );
    reviewed = true;
  } catch {
    reviewed = false;
  }
  check('点击后生成复盘卡片', reviewed, reviewed ? `${((Date.now() - t0) / 1000).toFixed(1)}s` : '90s 内没出现');
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/wrapup-02-review.png`, fullPage: true });

  const status = sql(`SELECT status || '|' || current_round || '|' || max_rounds FROM debate_room WHERE id=${roomId}`);
  check('房间状态已置为 finished 且轮次保留', status.startsWith('finished'), status);

  check('页面无 JS 报错', errors.length === 0, errors.slice(0, 3).join(' ／ '));
} catch (e) {
  R.fatal = String(e).slice(0, 400);
  log(`❌ 脚本异常：${R.fatal}`);
  await page.screenshot({ path: `${SHOTS}/wrapup-error.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  R.passed = R.checks.filter((c) => c.pass).length;
  R.total = R.checks.length;
  console.log(`\n  ══ 结果 ${R.passed}/${R.total} ══`);
  console.log(`  测试账号 ${USER}（user_id 稍后清理）`);
  console.log(`  RESULT_JSON ${JSON.stringify(R)}`);
}

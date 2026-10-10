/**
 * Bearer 令牌的本地存储 —— **只在 Cookie 靠不住的环境里兜底**。
 *
 * 【为什么需要它】
 *
 * 这个应用原本 100% 依赖 httpOnly Cookie 认证（前端刻意不存 token）。
 * 但 2026-10-09 实测发现：**微信内置浏览器根本不保存这个 Cookie**。
 *
 * nginx 日志里的证据（同一秒内）：
 *
 *   22:46:20  POST /api/auth/login   → 200     ← 登录成功，服务端下发了 Set-Cookie
 *   22:46:21  GET  /api/status-bar   → 401     ← 下一秒就认不出他了
 *
 * 服务端下发的 Cookie 确认无误（经 nginx 实测）：
 *
 *   dj_token=…; HttpOnly; Max-Age=604800; Path=/; SameSite=none; Secure
 *
 * 把 SameSite 从 lax 改成 none **没有解决** —— 说明微信不是「不发」，
 * 而是**根本不存**。改属性救不了「存不下」。
 *
 * 【代价，必须写清楚】
 *
 * token 从「JS 读不到」（httpOnly）变成「JS 可读」，多了一条 XSS 攻击面。
 * 之所以接受：
 *   · 这是同源、无第三方脚本的自有应用
 *   · 而微信用户**现在完全用不了** —— 两害相权
 *
 * 【为什么用 localStorage 而不是 sessionStorage】
 *
 * 本来是 sessionStorage 更安全（关标签页即清）。但微信的 webview 在
 * 重新打开时可能重建浏览上下文 —— 那种情况下 sessionStorage 会丢，
 * 用户每次都要重新登录，等于没修。
 *
 * 用 localStorage 但**带显式过期时间**：写入时记下时间戳，读取时检查。
 * 这样换来了「微信里关掉再打开仍是登录态」，同时把暴露窗口限制在
 * 和 JWT 本身一样的 7 天内。
 *
 * 【重要约束：必须与 Cookie 同生共死】
 *
 * 后端 `app/deps.py::extract_token` 里 **Bearer 优先于 Cookie**，
 * 这是刻意的（显式凭证必须赢，否则多账号场景会越权）。
 * 因此这里必须保证：登录时写入、登出时清除、失效时清除 ——
 * **任何情况下都不能留下一个陈旧 token**，否则它会盖住仍然有效的 Cookie，
 * 把「能用」变成「不能用」。
 */

/** 与 `settings.JWT_EXPIRE_DAYS` 一致（7 天）。服务端才是权威，这里只是提前止损。 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const TOKEN_KEY = 'dj_bearer_token';
const ISSUED_KEY = 'dj_bearer_issued_at';

function storage(): Storage | null {
  try {
    // 隐私模式 / 禁用存储时访问会抛异常，兜住
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getBearerToken(): string | null {
  const store = storage();
  if (!store) return null;
  try {
    const token = store.getItem(TOKEN_KEY);
    if (!token) return null;

    const issuedAt = Number(store.getItem(ISSUED_KEY) ?? '0');
    // 本地先判一次过期，省掉一次注定 401 的请求。
    // 真正过期与否仍以服务端为准 —— 这里只是止损。
    if (!issuedAt || Date.now() - issuedAt > MAX_AGE_MS) {
      clearBearerToken();
      return null;
    }
    return token;
  } catch {
    return null;
  }
}

export function setBearerToken(token: string): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(TOKEN_KEY, token);
    store.setItem(ISSUED_KEY, String(Date.now()));
  } catch {
    // 存不下就算了，退回到纯 Cookie 认证 —— 不能让登录本身失败
  }
}

export function clearBearerToken(): void {
  const store = storage();
  if (!store) return;
  try {
    store.removeItem(TOKEN_KEY);
    store.removeItem(ISSUED_KEY);
  } catch {
    // 忽略
  }
}

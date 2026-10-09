import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { registerSW } from 'virtual:pwa-register';

import App from './App';
import './styles/index.css';

/**
 * Service Worker 的更新接管。
 *
 * 为什么不能只用 injectRegister: 'auto' 自动生成的裸注册：
 * 那段代码只有一句 `navigator.serviceWorker.register('/sw.js')`，
 * **没有任何「发现新版本后让页面用上新代码」的逻辑**。
 * 结果是新版本部署后，用户看到的仍是旧页面，必须手动刷新才行 ——
 * 实测踩到了这个坑：功能已上线，用户却说「没有任何变化」。
 *
 * 这里显式接管：
 *   · immediate: true —— 不等 load 事件，尽早就绪
 *   · onNeedRefresh —— 检测到新版本时直接更新并刷新页面
 *   · onRegisteredSW —— **周期性检查**（见下）
 *
 * 对个人应用来说，「静默自动更新」比「弹窗问用户要不要更新」更合适：
 * 用户不关心版本号，只想打开就是最新的。
 *
 * ─────────────────────────────────────────────────────────────
 * 【为什么还要 onRegisteredSW 这一块】
 *
 * 上面那套 onNeedRefresh 只解决了一半问题。它依赖浏览器**发起更新检查**，
 * 而浏览器只在**页面加载**时才会去比对 sw.js。
 *
 * 于是有这么一种真实情况：
 *   用户把页面开着 → 我们发了新版 → 用户点了页面里的某个 Tab（SPA 内部跳转，
 *   没有页面加载）→ 他看到的**仍然是旧代码**，而且是"永远"看不到新的，
 *   除非他手动刷新或关掉重开。
 *
 * 这不是推测 —— 2026-10-08 发布好友功能时就是这样：部署成功、服务端证据齐全，
 * 用户在 SPA 里点进设置页却看不到新区块，手动 Ctrl+Shift+R 才出来。
 *
 * 所以这里主动补两块：
 *   · 定时检查（30 分钟一次）—— 覆盖"页面一直开着"的情况
 *   · 回到前台时检查 —— 移动端 App 切回来是最常见的场景
 *
 * 为什么是 30 分钟：sw.js 只有几百字节且带 no-cache，检查本身几乎无成本；
 * 但太频繁没有意义（用户也不会每 5 分钟就期待一次新版本）。真正要紧的是
 * **切回前台必查** —— 那才是用户"要开始用了"的时刻。
 */
const updateSW = registerSW({
  immediate: true,
  onNeedRefresh() {
    // updateSW(true) = 应用新 SW 并重载页面。
    // 自动做掉，不打断用户 —— 这是个工具，不是需要用户决策的软件。
    void updateSW(true);
  },
  onOfflineReady() {
    // 离线可用了。不弹提示：它不是用户此刻关心的事，
    // 而且 PWA 的离线能力应当是无感的。
  },
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return;

    const CHECK_INTERVAL_MS = 30 * 60 * 1000;

    // 定时检查：页面长时间开着时也能拿到新版本
    window.setInterval(() => {
      // update() 只负责"去问一下有没有新版"；
      // 真发现新版时由 onNeedRefresh 接管并重载，这里不需要处理结果。
      void registration.update().catch(() => {
        // 网络不通是常态（地铁、弱网），失败就等下一次，不要打扰用户
      });
    }, CHECK_INTERVAL_MS);

    // 切回前台立刻检查：这是用户"要开始用了"的时刻
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void registration.update().catch(() => {});
      }
    });
  },
});

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到挂载节点 #root');
}

createRoot(container).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

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
 *
 * 对个人应用来说，「静默自动更新」比「弹窗问用户要不要更新」更合适：
 * 用户不关心版本号，只想打开就是最新的。
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

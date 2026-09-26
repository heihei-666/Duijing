import { cpus } from 'node:os';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * workbox 生成 Service Worker 时会用 @rollup/plugin-terser 压缩，
 * 而该插件的 worker 池大小取自 os.cpus().length：
 * 个别容器（含本项目的开发容器）里 os.cpus() 返回空数组 →
 * worker 池为 0 → 永远不创建 worker → 构建卡死后报
 * "Unable to write the service worker file ... (terser) renderChunk"。
 *
 * 这不是代码问题，但为了让 `npm run build` 在任何环境都能跑通，
 * 检测到 CPU 数为 0 时退回 mode: 'development'（只是 SW 不压缩、体积 +2KB 左右，
 * 缓存与更新行为完全一致）。正常机器上仍然是 production + 压缩。
 */
const workboxMode = cpus().length === 0 ? 'development' : 'production';

// 对镜 · 构建配置
// 注意：manifest 使用仓库内的 public/manifest.webmanifest（可审阅、可手改），
// 因此这里把 vite-plugin-pwa 的 manifest 生成关掉（manifest: false），
// Service Worker 仍然由插件生成，index.html 里手动挂了 <link rel="manifest">。
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // 不再注入裸注册脚本：main.tsx 里用 virtual:pwa-register 显式接管，
      // 这样才能拿到 onNeedRefresh 回调去刷新页面。
      // 自动注入的那段只有 register()，新版本部署后用户看不到变化。
      injectRegister: false,
      manifest: false,
      includeAssets: ['favicon.svg', 'icons/icon.svg', 'icons/maskable.svg'],
      workbox: {
        mode: workboxMode,
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest,woff2}'],
        importScripts: ['push-handler.js'],
        navigateFallback: '/index.html',
        // API 与 SSE 永远走网络，不能被 SW 兜底成 index.html
        navigateFallbackDenylist: [/^\/api\//],
        cleanupOutdatedCaches: true,
      },
      devOptions: {
        enabled: false,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      // 后端 FastAPI（uvicorn --port 3000）
      '/api': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    target: 'es2020',
  },
});

import { AppShell } from '@/components/layout/AppShell';
import { LandingPage } from '@/pages/LandingPage';
import { useAuthStore } from '@/store/auth';

/**
 * 根路径 `/` 的分流层。
 *
 * 【为什么需要它】
 *
 * `/` 对两种人要有**完全不同的第一屏**：
 *
 *   · 已登录 —— 首页（状态栏、今天练什么、AI 昨天的观察）
 *   · 未登录 —— 落地页（大标题 + Slogan + 体验入口 + 灰色登录链接）
 *
 * 在此之前两种人都走 `RequireAuth`，未登录直接被弹到 `/login` 表单。
 * 那是「先交账号再谈体验」，市面上有一定规模的产品几乎没有这么做的。
 *
 * 【为什么不用 RequireAuth 改造】
 *
 * `RequireAuth` 的语义是「没登录就别进」，它对 `/debates`、`/assets` 都是对的。
 * 只有 `/` 是例外：**没登录也该能进，只是看到的东西不同**。
 * 所以给 `/` 单独一层分流，比在 `RequireAuth` 里加特判更清楚。
 */
export function RootLayout() {
  const status = useAuthStore((state) => state.status);

  if (status === 'authenticated') return <AppShell />;
  return <LandingPage />;
}

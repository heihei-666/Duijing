import { Navigate } from 'react-router-dom';

import { AppShell } from '@/components/layout/AppShell';
import { isGuest } from '@/lib/roles';
import { LandingPage } from '@/pages/LandingPage';
import { useAuthStore } from '@/store/auth';

/**
 * 根路径 `/` 的分流层。
 *
 * 【为什么需要它】
 *
 * `/` 对三种人要有**完全不同的第一屏**：
 *
 *   · 未登录 —— 落地页（大标题 + Slogan + 体验入口 + 灰色登录链接）
 *   · 访客   —— 访客开辩页（他还没东西可放在首页上）
 *   · 正式账号 —— 首页（状态栏、今天练什么、AI 昨天的观察）
 *
 * 在此之前三种人都走 `RequireAuth`，未登录直接被弹到 `/login` 表单。
 * 那是「先交账号再谈体验」，市面上有一定规模的产品几乎没有这么做的。
 *
 * 【为什么访客要重定向到 /start 而不是看到首页】
 *
 * 首页是「你昨天被观察到的东西」——那是**有历史的人**的首页。
 * 访客没有任何历史，进去只会看到一堆空白区块和「还没有数据」。
 * 让他在 `/start` 立刻辩一场，才是这个身份下唯一有意义的第一屏。
 *
 * 【为什么不用 RequireAuth 改造】
 *
 * `RequireAuth` 的语义是「没登录就别进」，它对 `/debates`、`/assets` 都是对的。
 * 只有 `/` 是例外：**没登录也该能进，只是看到的东西不同**。
 * 所以给 `/` 单独一层分流，比在 `RequireAuth` 里加特判更清楚。
 */
export function RootLayout() {
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);

  if (status !== 'authenticated') return <LandingPage />;
  if (isGuest(user)) return <Navigate to="/start" replace />;
  return <AppShell />;
}

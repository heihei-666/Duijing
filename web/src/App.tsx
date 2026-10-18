import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';

import { BootSplash } from '@/components/common/BootSplash';
import { AppShell } from '@/components/layout/AppShell';
import { GuestOnly } from '@/components/routing/GuestOnly';
import { RequireAuth } from '@/components/routing/RequireAuth';
import { RequireFullAccount } from '@/components/routing/RequireFullAccount';
import { RootLayout } from '@/components/routing/RootLayout';
import AssetsPage from '@/pages/AssetsPage';
import DebateJoinPage from '@/pages/DebateJoinPage';
import DebateRoomPage from '@/pages/DebateRoomPage';
import DebatesPage from '@/pages/DebatesPage';
import HomePage from '@/pages/HomePage';
import JoinPage from '@/pages/JoinPage';
import LoginPage from '@/pages/LoginPage';
import NotFoundPage from '@/pages/NotFoundPage';
import RegisterPage from '@/pages/RegisterPage';
import StartDebatePage from '@/pages/StartDebatePage';
import WeaknessDetailPage from '@/pages/WeaknessDetailPage';
import WeaknessesPage from '@/pages/WeaknessesPage';
import { useAuthStore } from '@/store/auth';

/**
 * 路由表（方案 2.2 + 访客模式）
 *
 *   /login /register /join/:code       → 未登录可见
 *   /                                  → 未登录：落地页；访客：跳 /start；正式账号：主框架
 *   /start                             → 访客开辩页（正式账号会被送走）
 *   /debates/:id                       → 辩论房。**正式账号和访客都进得来**
 *   /debates /weaknesses /assets       → 只有正式账号（访客看到「这是你的私人空间」）
 *
 * 会话在应用启动时通过 GET /api/auth/me 恢复；没恢复完先停在启动页，
 * 避免受保护页面闪一下才跳登录。
 *
 * 【访客为什么不是一条独立的路由前缀】
 *
 * 访客是一个真实登录用户（`is_guest`），和正式账号共用同一套页面与接口。
 * 给它加 `/guest/*` 前缀意味着所有页面都要写两遍、所有跳转都要判身份，
 * 而「哪些页面访客能用」是一个**正在变化**的产品决定（现在只有辩论房，
 * 以后可能放开资产）。用 `RequireFullAccount` 这种「一组路由 + 一个守卫」
 * 的写法，放开时把那条路由挪出守卫即可，不用改页面本身。
 */
export default function App() {
  const status = useAuthStore((state) => state.status);
  const bootstrap = useAuthStore((state) => state.bootstrap);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  if (status === 'idle' || status === 'loading') return <BootSplash />;

  return (
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/join/:code" element={<JoinPage />} />
      </Route>

      {/*
        根路径 `/` 分三种人（未登录 / 访客 / 正式账号），见 RootLayout 里的说明。
        只有 `/` 是例外 —— 其余受保护页面仍走 RequireAuth（没登录就别进）。
      */}
      <Route element={<RootLayout />}>
        <Route path="/" element={<HomePage />} />
      </Route>

      {/*
        访客开辩页。**刻意不套 RequireAuth**：这一页自己处理三种身份
        （未登录回落地页、正式账号回辩论列表、访客留在原地），
        套上 RequireAuth 会让未登录的人被弹到 /login 表单，
        而他本来只是想点一下落地页的主按钮。
      */}
      <Route path="/start" element={<StartDebatePage />} />

      <Route element={<RequireAuth />}>
        {/* 辩论房是全屏对话页：不套 AppShell，发言区自己吸底，避免和底部 Tab 抢位置。
            **访客唯一的可用页面**，所以它在 RequireFullAccount 之外。 */}
        <Route path="/debates/:id" element={<DebateRoomPage />} />

        <Route element={<RequireFullAccount />}>
          {/* 辩论邀请落地页：后端生成的链接是 /debate/join/{token}。
              被邀请者需要正式账号——访客没有好友关系，也没有历史弱点了。 */}
          <Route path="/debate/join/:token" element={<DebateJoinPage />} />

          <Route element={<AppShell />}>
            <Route path="/debates" element={<DebatesPage />} />
            <Route path="/weaknesses" element={<WeaknessesPage />} />
            <Route path="/weaknesses/:id" element={<WeaknessDetailPage />} />
            <Route path="/assets" element={<AssetsPage />} />
          </Route>
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

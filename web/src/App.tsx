import { useEffect } from 'react';
import { Route, Routes } from 'react-router-dom';

import { BootSplash } from '@/components/common/BootSplash';
import { AppShell } from '@/components/layout/AppShell';
import { GuestOnly } from '@/components/routing/GuestOnly';
import { RequireAuth } from '@/components/routing/RequireAuth';
import AssetsPage from '@/pages/AssetsPage';
import DebateJoinPage from '@/pages/DebateJoinPage';
import DebateRoomPage from '@/pages/DebateRoomPage';
import DebatesPage from '@/pages/DebatesPage';
import HomePage from '@/pages/HomePage';
import JoinPage from '@/pages/JoinPage';
import LoginPage from '@/pages/LoginPage';
import NotFoundPage from '@/pages/NotFoundPage';
import RegisterPage from '@/pages/RegisterPage';
import WeaknessDetailPage from '@/pages/WeaknessDetailPage';
import WeaknessesPage from '@/pages/WeaknessesPage';
import { useAuthStore } from '@/store/auth';

/**
 * 路由表（方案 2.2）
 *
 *   /login /register /join/:code   → 未登录可见
 *   /  /debates  /weaknesses  /assets → 登录后主框架（底部 4 Tab）
 *
 * 会话在应用启动时通过 GET /api/auth/me 恢复；没恢复完先停在启动页，
 * 避免受保护页面闪一下才跳登录。
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

      <Route element={<RequireAuth />}>
        {/* 辩论邀请落地页：后端生成的链接是 /debate/join/{token}，
            没有这条路由邀请链接会直接 404（整条多人辩论链路是断的）。
            放在 RequireAuth 内——被邀请者需要登录，各自独立账号。 */}
        <Route path="/debate/join/:token" element={<DebateJoinPage />} />

        {/* 辩论房是全屏对话页：不套 AppShell，发言区自己吸底，避免和底部 Tab 抢位置 */}
        <Route path="/debates/:id" element={<DebateRoomPage />} />

        <Route element={<AppShell />}>
          <Route path="/" element={<HomePage />} />
          <Route path="/debates" element={<DebatesPage />} />
          <Route path="/weaknesses" element={<WeaknessesPage />} />
          <Route path="/weaknesses/:id" element={<WeaknessDetailPage />} />
          <Route path="/assets" element={<AssetsPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

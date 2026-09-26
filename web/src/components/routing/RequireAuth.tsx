import { Navigate, Outlet, useLocation } from 'react-router-dom';

import { BootSplash } from '@/components/common/BootSplash';
import { useAuthStore } from '@/store/auth';

/** 受保护路由：未登录跳 /login，并把原地址放进 ?from= 便于登录后返回 */
export function RequireAuth() {
  const status = useAuthStore((state) => state.status);
  const location = useLocation();

  if (status === 'authenticated') return <Outlet />;
  if (status === 'idle' || status === 'loading') return <BootSplash />;

  const from = encodeURIComponent(`${location.pathname}${location.search}`);
  return <Navigate to={`/login?from=${from}`} replace />;
}

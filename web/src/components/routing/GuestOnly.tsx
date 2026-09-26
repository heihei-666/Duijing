import { Navigate, Outlet, useSearchParams } from 'react-router-dom';

import { useAuthStore } from '@/store/auth';

const AUTH_ROUTES = ['/login', '/register', '/join'];

/** 只允许未登录访问的页面：已登录直接回首页（或回到 ?from= 指定的位置） */
export function GuestOnly() {
  const status = useAuthStore((state) => state.status);
  const [searchParams] = useSearchParams();

  if (status !== 'authenticated') return <Outlet />;

  const from = searchParams.get('from');
  const safeFrom = from && from.startsWith('/') && !AUTH_ROUTES.some((r) => from.startsWith(r));
  return <Navigate to={safeFrom ? from : '/'} replace />;
}

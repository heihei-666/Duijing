import { Navigate, useParams } from 'react-router-dom';

/**
 * 邀请链接落地页 /join/:code。
 * 不做假页面：直接把邀请码带进注册页（未登录）或回首页（已登录由 GuestOnly 处理）。
 */
export default function JoinPage() {
  const { code = '' } = useParams<{ code: string }>();
  const invite = code.trim().toUpperCase();

  if (!invite) return <Navigate to="/register" replace />;

  // TODO(邀请落地)：如果以后要在注册前展示「谁邀请了你」，在这里加一次邀请码校验请求
  return <Navigate to={`/register?invite=${encodeURIComponent(invite)}`} replace />;
}

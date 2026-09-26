import { useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { useAuthStore } from '@/store/auth';

/**
 * 登录页。认证走 httpOnly Cookie，前端不保存 token。
 * 登录成功后不在这里 navigate：GuestOnly 会按 ?from= 把用户送回原地址。
 */
export default function LoginPage() {
  const login = useAuthStore((state) => state.login);

  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = username.trim();
    if (!trimmed || !password) {
      setError('请填写用户名和密码');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await login({ username: trimmed, password });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '登录失败，请稍后再试');
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="登录"
      subtitle="继续你上次没练完的那条回环。"
      footer={
        <span className="text-secondary">
          有邀请码？{' '}
          <Link to="/register" className="text-brand hover:text-brand-hover">
            去注册
          </Link>
        </span>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field
          label="用户名"
          name="username"
          autoComplete="username"
          placeholder="你的用户名"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <Field
          label="密码"
          name="password"
          type="password"
          autoComplete="current-password"
          placeholder="密码"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          登录
        </Button>

        {/* 故意不做成链接：这里没有自助重置入口，做成链接只会让人点进死路 */}
        <p className="text-center text-xs leading-relaxed text-tertiary">
          忘记密码？请联系开发者重置。
        </p>
      </form>
    </AuthLayout>
  );
}

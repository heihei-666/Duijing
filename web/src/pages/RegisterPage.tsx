import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { AuthLayout } from '@/components/layout/AuthLayout';
import { apiRequest } from '@/api/client';
import { useAuthStore } from '@/store/auth';

const MIN_PASSWORD_LENGTH = 8;

/**
 * 注册页（邀请制）。
 * 邀请码来源：/join/:code 跳转带的 ?invite=，或用户手输。
 */
export default function RegisterPage() {
  const register = useAuthStore((state) => state.register);
  const [searchParams] = useSearchParams();

  const [username, setUsername] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [inviteCode, setInviteCode] = useState((searchParams.get('invite') ?? '').toUpperCase());
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * 是否是本实例的第一个用户。
   * null = 还没问出来，此时按「需要邀请码」保守处理（老行为）。
   */
  const [isFirstUser, setIsFirstUser] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ needs_first_user: boolean }>('/auth/bootstrap', { redirectOn401: false })
      .then((data) => {
        if (!cancelled) setIsFirstUser(Boolean(data.needs_first_user));
      })
      .catch(() => {
        // 问不到就按需要邀请码处理，不阻塞注册
        if (!cancelled) setIsFirstUser(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedUsername = username.trim();
    const trimmedInvite = inviteCode.trim();
    if (!trimmedUsername) {
      setError('请填写用户名');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`密码至少 ${MIN_PASSWORD_LENGTH} 位`);
      return;
    }
    // 第一个用户不需要邀请码——后端也是这么判的（is_first_user 短路校验）。
    // 前端硬性要求填写，会让部署者第一次打开自己的站点时卡住：
    // 他手上不可能有邀请码，因为能发码的人还没注册。
    if (!isFirstUser && !trimmedInvite) {
      setError('请填写邀请码');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      await register({
        username: trimmedUsername,
        password,
        // 昵称选填：留空时用用户名兜底，保证契约字段一定有值
        nickname: nickname.trim() || trimmedUsername,
        invite_code: isFirstUser ? '' : trimmedInvite,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '注册失败，请稍后再试');
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="注册"
      subtitle={
        isFirstUser
          ? '你是这个实例的第一个用户，直接注册即可，不需要邀请码。'
          : '对镜目前是邀请制，需要一个邀请码。'
      }
      footer={
        <span className="text-secondary">
          已经有账号？{' '}
          <Link to="/login" className="text-brand hover:text-brand-hover">
            去登录
          </Link>
        </span>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4" noValidate>
        <Field
          label="用户名"
          name="username"
          autoComplete="username"
          placeholder="登录用，建议英文或拼音"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
        />
        <Field
          label="昵称"
          name="nickname"
          placeholder="选填，默认和用户名相同"
          value={nickname}
          onChange={(event) => setNickname(event.target.value)}
        />
        <Field
          label="密码"
          name="password"
          type="password"
          autoComplete="new-password"
          placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`}
          hint={`至少 ${MIN_PASSWORD_LENGTH} 位`}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
        {/* 第一个用户没有邀请码可填（能发码的人还没注册），直接不显示这个字段 */}
        {isFirstUser ? null : (
          <Field
            label="邀请码"
            name="invite_code"
            placeholder="例如 AB12CD34"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            className="tracking-[0.15em]"
            value={inviteCode}
            onChange={(event) => setInviteCode(event.target.value.toUpperCase())}
          />
        )}

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          {isFirstUser ? '创建账号' : '注册并进入'}
        </Button>
      </form>
    </AuthLayout>
  );
}

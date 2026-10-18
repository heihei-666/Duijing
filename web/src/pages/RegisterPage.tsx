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
   * 实例的注册策略（`GET /api/auth/bootstrap`）。
   *
   * null = 还没问出来，此时按「需要邀请码」保守处理（老行为）。
   *
   * 【为什么这里要读 open_register —— 一个真实存在的死锁】
   *
   * 之前这里只读了 `needs_first_user`，于是 `ALLOW_OPEN_REGISTER=true` 的部署里
   * 前端**仍然硬性要求填邀请码**，而那种实例上根本没有人发码 ——
   * 页面把用户挡在门外，后端的开放注册形同虚设。
   * （这个 bug 是本地跑浏览器点注册时报「请填写邀请码」才发现的，
   *   光看代码根本注意不到，因为后端那一侧是完全正确的。）
   */
  const [policy, setPolicy] = useState<{ needsFirstUser: boolean; openRegister: boolean } | null>(
    null,
  );
  const isFirstUser = policy?.needsFirstUser ?? false;
  const needsInvite = policy !== null && !policy.needsFirstUser && !policy.openRegister;

  useEffect(() => {
    let cancelled = false;
    apiRequest<{ needs_first_user: boolean; open_register?: boolean }>('/auth/bootstrap', {
      redirectOn401: false,
    })
      .then((data) => {
        if (cancelled) return;
        setPolicy({
          needsFirstUser: Boolean(data.needs_first_user),
          // 旧后端没有这个字段时按「需要邀请码」处理，保持老行为
          openRegister: Boolean(data.open_register),
        });
      })
      .catch(() => {
        // 问不到就按需要邀请码处理，不阻塞注册
        if (!cancelled) setPolicy({ needsFirstUser: false, openRegister: false });
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
    // 三种情况不需要邀请码：第一个用户、实例开放注册、（策略还没问出来时按需要处理）
    if (needsInvite && !trimmedInvite) {
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
        invite_code: needsInvite ? trimmedInvite : '',
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
        policy === null
          ? '正在确认这个实例的注册方式…'
          : isFirstUser
            ? '你是这个实例的第一个用户，直接注册即可，不需要邀请码。'
            : policy.openRegister
              ? '这个实例开放注册，直接填用户名和密码即可。'
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
        {/* 不需要邀请码时（第一个用户 / 开放注册）不显示这个字段 */}
        {needsInvite ? (
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
        ) : null}

        {error ? <p className="text-xs text-danger">{error}</p> : null}

        <Button type="submit" size="lg" fullWidth loading={submitting}>
          {isFirstUser ? '创建账号' : '注册并进入'}
        </Button>
      </form>
    </AuthLayout>
  );
}

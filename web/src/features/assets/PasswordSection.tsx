import { useState } from 'react';

import { apiRequest } from '@/api/client';
import { Button } from '@/components/common/Button';

/**
 * 修改自己的密码（方案 6.10）。
 *
 * 【为什么这个区块是必要的】
 *
 * 在这个区块之前，项目**根本没有改密码的入口** —— 用户忘了密码只能找开发者
 * 手工改库。2026-10-09 给 xww 重置密码时，就是我在服务器上直接写库做的，
 * 然后把新密码贴在聊天里。那不是功能，是运维事故的日常。
 *
 * 【为什么只在前端做校验，不信任它】
 *
 * 这里的「两次输入一致」「至少 8 位」只是为了**少一次往返**，
 * 真正的判定在服务端（`validate_password_strength` + 验当前密码）。
 * 前端的校验从来不是安全边界，只是体验优化。
 *
 * 【为什么必须填当前密码】
 *
 * 只看「已登录」不够：一台忘记登出的设备被人拿到，就能直接改密码把账号锁死。
 */
export function PasswordSection() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async () => {
    setError(null);
    setNotice(null);

    // 本地先挡一道，省掉一次注定失败的往返；服务端仍会独立校验
    if (current === '') return setError('请输入当前密码');
    if (next !== confirm) return setError('两次输入的新密码不一致');
    if (next === current) return setError('新密码不能与当前密码相同');

    setBusy(true);
    try {
      await apiRequest<{ ok: boolean }>('/account/password', {
        method: 'PATCH',
        body: { current_password: current, new_password: next },
      });
      setCurrent('');
      setNext('');
      setConfirm('');
      setNotice('密码已修改，下次登录请用新密码。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '修改失败，请重试');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-xl bg-surface px-4 py-4">
      <h3 className="text-[15px] font-medium text-primary">修改密码</h3>
      <p className="mt-1 text-xs leading-relaxed text-tertiary">
        需要先验证当前密码。改完之后，其他设备上已登录的会话不会立即失效，
        会在 7 天后自然过期。
      </p>

      <div className="mt-3 space-y-2">
        <label className="block">
          <span className="text-xs text-secondary">当前密码</span>
          <input
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(event) => setCurrent(event.target.value)}
            className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-primary"
          />
        </label>

        <label className="block">
          <span className="text-xs text-secondary">新密码（至少 8 位，不能是纯数字）</span>
          <input
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-primary"
          />
        </label>

        <label className="block">
          <span className="text-xs text-secondary">确认新密码</span>
          <input
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            className="mt-1 w-full rounded-lg bg-inset px-3 py-2 text-[14px] text-primary"
          />
        </label>
      </div>

      {error ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-[13px] text-danger">{error}</p>
      ) : null}

      {notice ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-[13px] text-success">{notice}</p>
      ) : null}

      <div className="mt-3">
        <Button loading={busy} disabled={busy} onClick={() => void submit()}>
          修改密码
        </Button>
      </div>
    </section>
  );
}

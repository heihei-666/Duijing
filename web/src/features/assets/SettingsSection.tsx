import { useCallback, useEffect, useState } from 'react';

import { authApi } from '@/api/client';
import type { InviteInfo } from '@/api/types';
import { Button } from '@/components/common/Button';
import { CheckIcon, CopyIcon } from '@/features/weakness/icons';
import { copyText } from '@/features/assets/clipboard';
import { useAuthStore } from '@/store/auth';

/**
 * 设置：我的邀请码 / 重置邀请码 / 登出。
 * 重置是不可逆的（旧码立刻失效），所以必须二次确认——先点一次变成确认按钮，再点才真的重置。
 * 登出后由 RequireAuth 自动跳登录页，这里不手动 navigate。
 */
export function SettingsSection() {
  const logout = useAuthStore((state) => state.logout);

  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState<'code' | 'link' | null>(null);

  const [confirmRotate, setConfirmRotate] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setInvite(await authApi.invite());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '邀请码加载失败');
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCopy(kind: 'code' | 'link', text: string) {
    const ok = await copyText(text);
    if (!ok) {
      setError('复制失败，长按上面的文字手动复制吧');
      return;
    }
    setError(null);
    setCopied(kind);
    window.setTimeout(() => setCopied(null), 2000);
  }

  async function handleRotate() {
    setRotating(true);
    setError(null);
    try {
      // rotateInvite 只返回新的 { code }，link / used_count 不在响应里，
      // 所以重置后要重新拉一次完整信息（used_count 重置后不变）。
      await authApi.rotateInvite();
      const refreshed = await authApi.invite();
      setInvite(refreshed);
      setConfirmRotate(false);
      setNotice('已重置，旧邀请码立刻失效');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重置失败，请稍后再试');
    } finally {
      setRotating(false);
    }
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-light bg-surface px-4 py-4 shadow-card">
        <h3 className="text-[13px] text-secondary">我的邀请码</h3>

        {invite === null ? (
          <p className="mt-3 text-[13px] text-tertiary">{error ?? '正在读取…'}</p>
        ) : (
          <>
            <div className="mt-3 flex items-center gap-2">
              <span className="select-all text-[20px] font-medium tracking-[0.15em] text-primary">
                {invite.code}
              </span>
              <button
                type="button"
                aria-label="复制邀请码"
                onClick={() => void handleCopy('code', invite.code)}
                className="flex h-11 w-11 items-center justify-center rounded-lg text-tertiary hover:bg-elevated"
              >
                {copied === 'code' ? <CheckIcon className="text-success" /> : <CopyIcon />}
              </button>
            </div>

            <p className="mt-1 break-all text-xs text-tertiary">{invite.link}</p>

            <div className="mt-2 flex items-center gap-2">
              <Button variant="outline" onClick={() => void handleCopy('link', invite.link)}>
                {copied === 'link' ? '已复制链接' : '复制邀请链接'}
              </Button>
              <span className="text-xs text-tertiary">已使用 {invite.used_count} 次</span>
            </div>

            <div className="mt-4 border-t border-light pt-3">
              {confirmRotate ? (
                <div className="space-y-2">
                  <p className="text-[13px] leading-relaxed text-secondary">
                    重置后旧邀请码立刻失效，已经用旧码注册的人不受影响。
                  </p>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      className="border-danger text-danger hover:bg-danger-light"
                      loading={rotating}
                      disabled={rotating}
                      onClick={() => void handleRotate()}
                    >
                      确认重置
                    </Button>
                    <Button
                      variant="ghost"
                      disabled={rotating}
                      onClick={() => setConfirmRotate(false)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              ) : (
                <Button variant="ghost" className="text-tertiary" onClick={() => setConfirmRotate(true)}>
                  重置邀请码
                </Button>
              )}
            </div>
          </>
        )}

        {error && invite !== null ? <p className="mt-2 text-xs text-danger">{error}</p> : null}
        {notice ? <p className="mt-2 text-xs text-tertiary">{notice}</p> : null}
      </section>

      <Button variant="outline" fullWidth loading={loggingOut} onClick={() => void handleLogout()}>
        登出
      </Button>
    </div>
  );
}

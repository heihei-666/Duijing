import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { copyText } from '@/features/assets/clipboard';
import { formatTimestamp } from '@/lib/date';
import { useAuthStore } from '@/store/auth';

import { listUsers, resetUserPassword, type AdminUser, type ResetPasswordResult } from './api';

/**
 * 用户管理（只有管理员看得到）。
 *
 * 【这个区块存在的理由】
 *
 * 这个项目**没有邮件、没有短信、用户表里也没有邮箱字段**。用户忘了密码，
 * 唯一能帮他的就是管理员。在这个区块之前，那条路是：
 *
 *   用户找开发者 → 开发者在服务器上直接写库 → 把新密码贴在聊天窗口里
 *
 * 2026-10-09 给 xww 重置时走的就是这条。**那不是功能，是运维事故的日常。**
 *
 * 【两个刻意的设计】
 *
 * 1. **重置是两步的**。它不是「删除」那种不可逆操作，但它会让对方立刻登不上 ——
 *    点错一次就要再解释一轮。所以先确认，再执行。
 *
 * 2. **临时密码只显示一次，并明确说清「立刻改掉」**。
 *    服务端只在这一次响应里返回它，之后库里只有哈希，谁都拿不回来。
 *    界面必须让人意识到这一点，否则对方会一直用这个临时密码。
 */
export function AdminUsersSection() {
  const currentUser = useAuthStore((state) => state.user);

  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** 待确认重置的用户 id —— 两步确认的第一步 */
  const [confirming, setConfirming] = useState<number | null>(null);
  const [busy, setBusy] = useState<number | null>(null);
  const [result, setResult] = useState<ResetPasswordResult | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await listUsers();
      setUsers(data.users);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '用户列表加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleReset = async (userId: number) => {
    setBusy(userId);
    setError(null);
    setResult(null);
    setCopied(false);
    try {
      setResult(await resetUserPassword(userId));
      setConfirming(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '重置失败，请重试');
    } finally {
      setBusy(null);
    }
  };

  const handleCopy = async () => {
    if (!result) return;
    setCopied(await copyText(result.temp_password));
  };

  // 不是管理员就不渲染。服务端也会独立鉴权（require_admin），
  // 这里只是不给出一个注定 403 的入口。
  if (!currentUser?.is_admin) return null;

  return (
    <section className="rounded-xl bg-surface px-4 py-4">
      <h3 className="text-[15px] font-medium text-primary">用户管理</h3>
      <p className="mt-1 text-xs leading-relaxed text-tertiary">
        这个实例没有邮件和短信，用户忘了密码只能由管理员重置。
      </p>

      {error ? (
        <p className="mt-3 rounded-lg bg-elevated px-3 py-2 text-[13px] text-danger">{error}</p>
      ) : null}

      {result ? (
        <div className="mt-3 rounded-lg bg-elevated px-3 py-3">
          <p className="text-[13px] text-secondary">
            {result.username} 的新临时密码{result.is_self ? '（这是你自己的账号）' : ''}
          </p>
          <p className="mt-1 select-all break-all rounded-lg bg-inset px-3 py-2 text-[15px] text-primary">
            {result.temp_password}
          </p>
          <p className="mt-2 text-xs leading-relaxed text-tertiary">{result.note}</p>
          <div className="mt-2">
            <Button variant="outline" onClick={() => void handleCopy()}>
              {copied ? '已复制' : '复制临时密码'}
            </Button>
          </div>
        </div>
      ) : null}

      {loading && users.length === 0 ? (
        <p className="mt-3 text-[13px] text-tertiary">加载中…</p>
      ) : null}

      <ul className="mt-3 space-y-2">
        {users.map((item) => {
          const isSelf = item.id === currentUser.id;
          return (
            <li
              key={item.id}
              className="flex items-center justify-between gap-2 rounded-lg bg-elevated px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-primary">
                  {item.nickname}
                  {item.is_admin ? <span className="ml-1 text-xs text-tertiary">管理员</span> : null}
                  {isSelf ? <span className="ml-1 text-xs text-tertiary">你</span> : null}
                </p>
                <p className="truncate text-xs text-tertiary">
                  @{item.username} · {formatTimestamp(item.created_at)}
                  {item.deletion_requested_at ? ' · 已申请注销' : ''}
                </p>
              </div>

              {confirming === item.id ? (
                <div className="flex shrink-0 items-center gap-2">
                  <Button
                    variant="outline"
                    loading={busy === item.id}
                    disabled={busy !== null}
                    onClick={() => void handleReset(item.id)}
                  >
                    确认重置
                  </Button>
                  <Button
                    variant="ghost"
                    disabled={busy !== null}
                    onClick={() => setConfirming(null)}
                  >
                    取消
                  </Button>
                </div>
              ) : (
                <Button
                  variant="outline"
                  className="shrink-0"
                  disabled={busy !== null}
                  onClick={() => {
                    setConfirming(item.id);
                    setResult(null);
                  }}
                >
                  重置密码
                </Button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

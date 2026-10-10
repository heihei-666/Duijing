import { useCallback, useEffect, useState } from 'react';

import { apiRequest, authApi } from '@/api/client';
import type { InviteInfo } from '@/api/types';
import { Button } from '@/components/common/Button';
import { NotificationSettings } from '@/features/push/NotificationSettings';
import { FriendsSection } from '@/features/friends/FriendsSection';
import { PasswordSection } from '@/features/assets/PasswordSection';
import { SettingsGroup, SettingsRow } from '@/features/assets/SettingsGroup';
import { AdminUsersSection } from '@/features/admin/AdminUsersSection';
import { CheckIcon, CopyIcon } from '@/features/weakness/icons';
import { copyText } from '@/features/assets/clipboard';
import { formatTimestamp } from '@/lib/date';
import { ADMIN_ROLE, canSee } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';

/**
 * 设置：我的邀请码 / 重置邀请码 / 通知 / 关于与数据 / 登出。
 * 重置是不可逆的（旧码立刻失效），所以必须二次确认——先点一次变成确认按钮，再点才真的重置。
 * 登出后由 RequireAuth 自动跳登录页，这里不手动 navigate。
 */
export function SettingsSection() {
  const logout = useAuthStore((state) => state.logout);
  // 分组可见性按角色判定（见 lib/roles.ts）。用 user 而不是 is_admin，
  // 是为了将来加角色时只改 rolesOf 一处。
  const currentUser = useAuthStore((state) => state.user);

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
      {/*
        ── 管理 ─────────────────────────────────────────────────

        角色独有的组放在**最前面**：管理员进来第一眼就该看到管理入口，
        而不是滚到底才找到。

        将来加别的角色（督导、只读观察者…）时，它的组也加在这里、
        在通用组之前 —— 这是约定，不是巧合。

        `canSee` 只是不给出一个注定 403 的入口；真正的鉴权在服务端
        （`require_admin`）。前端隐藏从来不是安全边界。
      */}
      {canSee([ADMIN_ROLE], currentUser) ? (
        <SettingsGroup title="管理">
          <AdminUsersSection />
        </SettingsGroup>
      ) : null}

      {/* ── 账号 ──────────────────────────────────────────────── */}
      <SettingsGroup title="账号">
        <SettingsRow label="我的邀请码" description="分享给朋友，他们凭码注册。">
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
      </SettingsRow>

      {/* 修改密码和邀请码同属「账号」—— 都是账号的基础设置 */}
      <PasswordSection />
      </SettingsGroup>

      {/* ── 社交 ────────────────────────────────────────────── */}
      <SettingsGroup title="社交">
        <FriendsSection />
      </SettingsGroup>

      {/* ── 通知 ────────────────────────────────────────────── */}
      <SettingsGroup title="通知">
        <NotificationSettings />
      </SettingsGroup>

      {/* ── 数据 ────────────────────────────────────────────── */}
      <SettingsGroup title="数据">
        <AccountDataSection />
      </SettingsGroup>

      <Button variant="outline" fullWidth loading={loggingOut} onClick={() => void handleLogout()}>
        登出
      </Button>
    </div>
  );
}

/* ------------------------------------------------------------ 账号数据接口 */

/**
 * 对应《个人信息保护法》里的两项权利（后端 app/api/account.py）：
 *   · 可携带 —— GET /api/account/export
 *   · 可删除 —— GET / POST / DELETE /api/account/deletion
 *
 * `client.ts` 里没有这四个方法（那个文件不允许改），用 `apiRequest` 补齐。
 * 导出接口例外：它返回的是 JSON 文件 + Content-Disposition 响应头，
 * 而且要注意的是——`apiRequest` 只解析 JSON、拿不到响应头，所以走原生 fetch。
 */

interface DeletionStatus {
  requested: boolean;
  requested_at: string | null;
}

interface DeletionRequestResult {
  ok: boolean;
  requested_at: string | null;
  message: string;
}

function getDeletionStatus(): Promise<DeletionStatus> {
  return apiRequest<DeletionStatus>('/account/deletion');
}

function requestAccountDeletion(): Promise<DeletionRequestResult> {
  return apiRequest<DeletionRequestResult>('/account/deletion', { method: 'POST' });
}

function cancelAccountDeletion(): Promise<{ ok: boolean; requested: boolean }> {
  return apiRequest<{ ok: boolean; requested: boolean }>('/account/deletion', { method: 'DELETE' });
}

/** 从 Content-Disposition 里取文件名；`filename*=UTF-8''…`（能带中文）优先 */
export function exportFilenameFromHeader(header: string | null): string | null {
  if (!header) return null;

  const encoded = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1].trim());
    } catch {
      // 编码坏了就退回普通 filename
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || null;
}

/** 取不到响应头时自己拼：duijing-export-YYYYMMDD.json */
function fallbackExportFilename(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `duijing-export-${now.getFullYear()}${month}${day}.json`;
}

/**
 * fetch（带 Cookie）→ blob → URL.createObjectURL → 触发 <a download>。
 * 刻意不用 window.open / location.assign：那两个拿不到错误响应，
 * 401 或 500 的时候用户只会看到一个空白页，不知道发生了什么。
 */
async function downloadAccountExport(): Promise<string> {
  const response = await fetch('/api/account/export', {
    credentials: 'include',
    headers: { Accept: 'application/json' },
  });

  if (!response.ok) {
    let detail = '';
    try {
      const data: unknown = await response.json();
      if (data && typeof data === 'object' && 'detail' in data) {
        detail = String((data as { detail: unknown }).detail ?? '');
      }
    } catch {
      // 不是 JSON，用状态码兜底
    }
    if (detail) throw new Error(detail);
    throw new Error(
      response.status === 401 ? '登录状态已失效，请重新登录后再试。' : `导出失败（${response.status}）`,
    );
  }

  const blob = await response.blob();
  const filename =
    exportFilenameFromHeader(response.headers.get('Content-Disposition')) ?? fallbackExportFilename();

  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = objectUrl;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // 立刻 revoke 会让部分浏览器取消下载，延迟释放
  window.setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);

  return filename;
}

/* -------------------------------------------------------- 关于与数据（UI） */

/**
 * 导出与注销。
 *
 * 注销按配色方案用 `--danger`（砖红 #B85C5C），不做成刺眼的纯红实底——
 * 这是一件需要用户冷静确认的事，不是需要被一眼看见的促销按钮。
 * 文案如实说明：这是**申请标记**，人工确认后才删除，期间可正常使用、可撤销。
 */
function AccountDataSection() {
  const [deletion, setDeletion] = useState<DeletionStatus | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await getDeletionStatus();
        if (!cancelled) setDeletion(status);
      } catch (cause) {
        if (!cancelled) {
          setLoadError(cause instanceof Error ? cause.message : '注销状态读取失败');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleExport() {
    setExporting(true);
    setError(null);
    setNotice(null);
    try {
      const filename = await downloadAccountExport();
      setNotice(`已导出 ${filename}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '导出失败，请稍后再试');
    } finally {
      setExporting(false);
    }
  }

  async function handleRequestDeletion() {
    setRequesting(true);
    setError(null);
    setNotice(null);
    try {
      const result = await requestAccountDeletion();
      setDeletion({ requested: true, requested_at: result.requested_at });
      setConfirming(false);
      // 用后端原话说明「人工确认后才删除，期间仍可正常使用」
      setNotice(result.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '申请失败，请稍后再试');
    } finally {
      setRequesting(false);
    }
  }

  async function handleCancelDeletion() {
    setCancelling(true);
    setError(null);
    setNotice(null);
    try {
      await cancelAccountDeletion();
      setDeletion({ requested: false, requested_at: null });
      setNotice('已撤销注销申请，数据都还在。');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '撤销失败，请稍后再试');
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      {/*
        「拿走我的数据」和「删掉我的数据」原本挤在同一节里，
        但两者的心理分量完全不同 —— 拆成两行之后才看得清。
      */}
      <SettingsRow
        label="导出数据"
        description="下载一个 JSON 文件：弱点、回环与撑住记录、优势、原则、事件卡、辩论与复盘、提醒。不包含密码。"
        action={
          <Button variant="outline" loading={exporting} onClick={() => void handleExport()}>
            导出
          </Button>
        }
      />

      <SettingsRow label="注销账号">

        {deletion === null ? (
          <p className="mt-2 text-xs leading-relaxed text-tertiary">{loadError ?? '正在读取…'}</p>
        ) : deletion.requested ? (
          <>
            <p className="mt-2 text-[13px] leading-relaxed text-secondary">
              已提交注销申请
              {deletion.requested_at ? `（${formatTimestamp(deletion.requested_at)}）` : ''}。
            </p>
            <p className="mt-1 text-xs leading-relaxed text-tertiary">
              这只是一条申请标记，不会立刻删除：开发者人工确认后才会清除数据。
              这期间账号可以正常使用，也可以随时撤销。
            </p>
            <Button
              variant="ghost"
              className="mt-1"
              loading={cancelling}
              onClick={() => void handleCancelDeletion()}
            >
              撤销申请
            </Button>
          </>
        ) : confirming ? (
          <div className="mt-2 space-y-2">
            <p className="text-[13px] leading-relaxed text-secondary">
              注销后，你的弱点、回环与撑住记录、优势和原则、事件卡、辩论与复盘都会
              <span className="text-danger">永久删除，无法恢复</span>。
            </p>
            <p className="text-xs leading-relaxed text-tertiary">
              提交后不会立刻删除：这只是一条注销申请，开发者人工确认后才执行，期间你仍可正常使用，
              也可以随时撤销。推送订阅会立即取消，之后不会再收到任何通知。
              想留一份的话，先点上面的「导出我的全部数据」。
            </p>
            <div className="flex gap-2">
              <Button
                variant="outline"
                className="border-danger text-danger hover:bg-danger-light"
                loading={requesting}
                onClick={() => void handleRequestDeletion()}
              >
                确认申请注销
              </Button>
              <Button variant="ghost" disabled={requesting} onClick={() => setConfirming(false)}>
                取消
              </Button>
            </div>
          </div>
        ) : (
          <>
            <p className="mt-2 text-xs leading-relaxed text-tertiary">
              提交的是注销申请，不会立刻删除数据：人工确认后才执行，期间可以正常使用。
            </p>
            <button
              type="button"
              onClick={() => {
                setConfirming(true);
                setNotice(null);
                setError(null);
              }}
              className="mt-1 flex min-h-[44px] items-center text-[13px] text-danger hover:opacity-80"
            >
              申请注销账号
            </button>
          </>
        )}

        {error ? <p className="mt-2 text-xs leading-relaxed text-danger">{error}</p> : null}
        {notice ? <p className="mt-2 text-xs leading-relaxed text-secondary">{notice}</p> : null}
      </SettingsRow>
    </>
  );
}

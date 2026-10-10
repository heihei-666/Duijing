import { useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import { listFriends, type FriendItem } from '@/features/friends/api';

import type { DebateInviteResult } from './api';
import { inviteToDebate } from './api';
import { CopyIcon } from './icons';

interface InviteSheetProps {
  open: boolean;
  invite: DebateInviteResult | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
  /** 用于「从好友邀请」——给好友直接发待接受邀请，不用他们点链接 */
  roomId: number;
  /** 好友邀请成功后通知父级刷新（参与者人数等） */
  onInvited?: () => void;
}

/**
 * 被跳过的原因翻译成人话。
 *
 * 后端返回的是机器可读的短标识，**不认识的一律兜底**而不是原样显示 ——
 * 那样用户会看到 `already_invited` 这种内部字符串。
 */
const SKIP_REASON: Record<string, string> = {
  already_invited: '已经邀请过了',
  already_member: '已经在房间里',
  not_friend: '不是好友了',
  room_full: '名额已满',
  self: '不能邀请自己',
};

/** 复制到剪贴板：优先 Clipboard API，非安全上下文/被拒时退回选区复制 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 落到兜底方案
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}

/**
 * 邀请（契约 3 章 POST /api/debates/{id}/invite，最多 4 人含发起人）。
 *
 * 两条路并存，不是冗余：
 *
 *   · **复制链接** —— 通用。对方可以转发给任何人，包括还没有账号的人。
 *   · **从好友邀请**（方案 6.9）—— 直接给好友发一条**待接受**的邀请，
 *     对方在自己那边点一下就行，不用来回贴链接。
 *
 * **关键的不对称**：好友被邀请后**不是直接进房间**，而是收到一条待接受的邀请。
 * 「我邀请你」和「你已经在我的房间里」是强度完全不同的两件事 ——
 * 房间里有弱点、有回环、有 AI 观察。
 */
export function InviteSheet({
  open,
  invite,
  loading,
  error,
  onClose,
  roomId,
  onInvited,
}: InviteSheetProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const [friends, setFriends] = useState<FriendItem[]>([]);
  const [selected, setSelected] = useState<number[]>([]);
  const [invitingFriends, setInvitingFriends] = useState(false);
  const [friendNote, setFriendNote] = useState<string | null>(null);
  const [friendError, setFriendError] = useState<string | null>(null);

  // 每次重新打开都清掉上一次的反馈
  useEffect(() => {
    if (!open) return;
    setCopied(false);
    setCopyFailed(false);
    setSelected([]);
    setFriendNote(null);
    setFriendError(null);

    // 拉好友列表；失败就静默降级成「只能复制链接」，不打扰用户
    let alive = true;
    void listFriends()
      .then((result) => {
        if (alive) setFriends(result.friends);
      })
      .catch(() => {
        if (alive) setFriends([]);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const handleCopy = async () => {
    if (!invite) return;
    const ok = await copyText(invite.link);
    setCopied(ok);
    setCopyFailed(!ok);
  };

  const toggle = (userId: number) => {
    setSelected((prev) =>
      prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId],
    );
  };

  const handleInviteFriends = async () => {
    if (selected.length === 0) return;
    setInvitingFriends(true);
    setFriendError(null);
    setFriendNote(null);
    try {
      const result = await inviteToDebate(roomId, selected);
      const sent = result.invited?.length ?? selected.length;
      const skipped = result.skipped ?? [];

      let message = `已邀请 ${sent} 位好友，对方接受后才会进房间。`;
      if (skipped.length > 0) {
        const reasons = [...new Set(skipped.map((item) => SKIP_REASON[item.reason] ?? '暂时无法邀请'))];
        message += ` ${skipped.length} 位未发出：${reasons.join('、')}。`;
      }
      setFriendNote(message);
      setSelected([]);
      onInvited?.();
    } catch (cause) {
      setFriendError(cause instanceof Error ? cause.message : '邀请好友失败，请重试');
    } finally {
      setInvitingFriends(false);
    }
  };

  return (
    <Sheet
      open={open}
      title="邀请一起辩"
      onClose={onClose}
      footer={
        <Button fullWidth disabled={!invite || loading} onClick={() => void handleCopy()}>
          <CopyIcon />
          {copied ? '已复制' : '复制链接'}
        </Button>
      }
    >
      <div className="space-y-3">
        <p className="text-[13px] leading-relaxed text-secondary">
          {invite
            ? `已加入 ${invite.participant_count} / ${invite.max_participants} 人。`
            : loading
              ? '正在生成邀请链接…'
              : '还没有可用的邀请链接。'}
        </p>

        {invite ? (
          <p className="select-all break-all rounded-xl border border-light bg-elevated px-3 py-2.5 text-[13px] leading-relaxed text-primary">
            {invite.link}
          </p>
        ) : null}

        {copyFailed ? (
          <p className="text-xs leading-relaxed text-warning">
            复制没成功，长按上面的链接手动复制。
          </p>
        ) : null}

        {error ? <p className="text-xs leading-relaxed text-danger">{error}</p> : null}

        {/* ── 从好友邀请（方案 6.9）──────────────────────────── */}
        {friends.length > 0 ? (
          <div className="rounded-xl bg-elevated px-3 py-3">
            <p className="text-[13px] text-secondary">从好友邀请（{friends.length}）</p>
            <p className="mt-1 text-xs leading-relaxed text-tertiary">
              对方会收到一条待接受的邀请，接受后才进房间。
            </p>

            <ul className="mt-2 space-y-2">
              {friends.map((friend) => {
                const checked = selected.includes(friend.user_id);
                return (
                  <li key={friend.user_id}>
                    <button
                      type="button"
                      onClick={() => toggle(friend.user_id)}
                      className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-[13px] ${
                        checked ? 'bg-surface text-primary' : 'text-secondary'
                      }`}
                    >
                      <span className="min-w-0 flex-1 truncate">
                        {friend.nickname || friend.username}
                      </span>
                      <span className="shrink-0 text-xs text-tertiary">
                        {checked ? '已选' : '选择'}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>

            {friendError ? (
              <p className="mt-2 text-xs leading-relaxed text-danger">{friendError}</p>
            ) : null}

            {friendNote ? (
              <p className="mt-2 text-xs leading-relaxed text-success">{friendNote}</p>
            ) : null}

            <div className="mt-3">
              <Button
                variant="outline"
                fullWidth
                loading={invitingFriends}
                disabled={invitingFriends || selected.length === 0}
                onClick={() => void handleInviteFriends()}
              >
                {selected.length === 0 ? '选择好友' : `邀请这 ${selected.length} 位好友`}
              </Button>
            </div>
          </div>
        ) : null}

        <p className="text-xs leading-relaxed text-tertiary">
          对方需要有自己的账号。被邀请者看不到你的弱点、回环和 AI 观察。
        </p>
      </div>
    </Sheet>
  );
}

import { useEffect, useState } from 'react';

import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';

import type { DebateInviteResult } from './api';
import { CopyIcon } from './icons';

interface InviteSheetProps {
  open: boolean;
  invite: DebateInviteResult | null;
  loading: boolean;
  error: string | null;
  onClose: () => void;
}

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
 * 链接由服务端生成，这里只负责展示与复制；不猜字段名，用返回的 `link`。
 */
export function InviteSheet({ open, invite, loading, error, onClose }: InviteSheetProps) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  // 每次重新打开都清掉上一次的复制反馈
  useEffect(() => {
    if (open) {
      setCopied(false);
      setCopyFailed(false);
    }
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

        <p className="text-xs leading-relaxed text-tertiary">
          对方需要有自己的账号。被邀请者看不到你的弱点、回环和 AI 观察。
        </p>
      </div>
    </Sheet>
  );
}

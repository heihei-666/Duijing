import { useState } from 'react';

import { Button } from '@/components/common/Button';
import { cn } from '@/lib/cn';

import { DEBATE_MESSAGE_MAX_CHARS, countChars } from './api';

interface DebateComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  /** 发言请求中 */
  sending: boolean;
  /** AI 正在流式回复 */
  streaming: boolean;
  /** 房间状态：active / paused / finished */
  status: 'active' | 'paused' | 'finished' | 'abandoned';
  /** 流内错误（可重试） */
  streamError: string | null;
  onRetryStream: () => void;
  onAbandon: () => void;
  abandoning: boolean;
  /** 操作错误（发言 / 放弃本轮） */
  error: string | null;
  /** 系统提示（最后一轮、已暂停、已结束） */
  notice: string | null;
}

/**
 * 发言区（吸底）。
 * 契约 3 章 + 11 章：每轮 ≤ 300 字，超出后端 400，所以这里实时计数并直接禁用发送。
 * 计数按 Unicode 码点（见 api.ts 的 countChars），和后端 len() 对齐。
 */
export function DebateComposer({
  value,
  onChange,
  onSend,
  sending,
  streaming,
  status,
  streamError,
  onRetryStream,
  onAbandon,
  abandoning,
  error,
  notice,
}: DebateComposerProps) {
  const [confirmAbandon, setConfirmAbandon] = useState(false);

  const count = countChars(value);
  const overLimit = count > DEBATE_MESSAGE_MAX_CHARS;
  const trimmed = value.trim();
  const paused = status === 'paused';
  const finished = status === 'finished' || status === 'abandoned';

  const disabledReason = finished
    ? '这场辩论已经结束，输入已关闭。'
    : paused
      ? '已暂停。点上方「继续」后可以接着发言。'
      : streaming
        ? 'AI 正在回应，等它说完这一轮。'
        : overLimit
          ? `已超出 ${DEBATE_MESSAGE_MAX_CHARS} 字，删减后再发送。`
          : null;

  const canSend =
    !finished && !paused && !streaming && !sending && !overLimit && trimmed !== '';

  return (
    <div className="sticky bottom-0 z-20 border-t border-light bg-surface px-4 pb-3 pt-3 dj-safe-bottom">
      {streamError ? (
        <div className="mb-2 flex items-center justify-between gap-3 rounded-xl bg-danger-light px-3 py-2">
          <p className="text-xs leading-relaxed text-danger">{streamError}</p>
          <Button variant="outline" className="shrink-0" onClick={onRetryStream}>
            重试
          </Button>
        </div>
      ) : null}

      {error ? <p className="mb-2 text-xs text-danger">{error}</p> : null}
      {notice ? (
        <p className="mb-2 rounded-xl bg-info-light px-3 py-2 text-xs leading-relaxed text-info">
          {notice}
        </p>
      ) : null}

      <label className="sr-only" htmlFor="debate-composer">
        你的发言
      </label>
      <textarea
        id="debate-composer"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          // 手机端回车＝换行，桌面端给一个 Ctrl/Cmd + Enter 的快捷发送
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && canSend) {
            event.preventDefault();
            onSend();
          }
        }}
        rows={3}
        disabled={finished || paused}
        placeholder={paused ? '暂停中…' : '说你的论点，和上一轮一样清楚。'}
        className={cn(
          'min-h-[88px] w-full resize-none rounded-xl border bg-elevated px-3 py-2.5',
          'text-[15px] leading-relaxed text-primary placeholder:text-disabled',
          'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary',
          'disabled:cursor-not-allowed disabled:text-tertiary',
          overLimit ? 'border-danger' : 'border-light',
        )}
      />

      <div className="mt-1.5 flex items-center justify-end">
        <span className={cn('text-[11px] tabular-nums', overLimit ? 'text-danger' : 'text-tertiary')}>
          {count} / {DEBATE_MESSAGE_MAX_CHARS}
        </span>
      </div>

      {disabledReason ? (
        <p className="mt-1 text-[11px] leading-relaxed text-tertiary">{disabledReason}</p>
      ) : null}

      <div className="mt-2.5 flex items-center justify-between gap-3">
        {finished ? (
          <span />
        ) : confirmAbandon ? (
          <span className="flex items-center gap-1.5">
            <Button
              variant="ghost"
              className="text-danger hover:bg-danger-light"
              loading={abandoning}
              onClick={() => {
                setConfirmAbandon(false);
                onAbandon();
              }}
            >
              确认放弃
            </Button>
            <Button variant="ghost" onClick={() => setConfirmAbandon(false)}>
              取消
            </Button>
          </span>
        ) : (
          <Button
            variant="ghost"
            disabled={paused || sending || streaming}
            onClick={() => setConfirmAbandon(true)}
          >
            这轮我放弃
          </Button>
        )}

        <Button className="min-w-[96px]" disabled={!canSend} loading={sending} onClick={onSend}>
          发送
        </Button>
      </div>
    </div>
  );
}

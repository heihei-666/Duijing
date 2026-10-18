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
  /**
   * 提示里带的内联操作。
   *
   * 为什么必须有它：房间操作行（暂停 / 邀请 / 结束并复盘）在消息列表**顶部**，
   * 是刻意不吸顶的（见 RoomActions 注释）。但一句话把人指到屏幕外好几屏的按钮上，
   * 等于没有按钮——用户辩到第 8 轮时停在底部，只会看到「可以点结束并复盘」却点不到。
   * 所以凡是「提示里提到某个动作」的，都在提示自己这一行给出这个动作。
   */
  noticeAction?: {
    label: string;
    onClick: () => void;
    loading?: boolean;
  } | null;
  /**
   * 「我卡住了，给我提示」—— 让 AI 给一个能接得住的话头。
   *
   * 为什么这个按钮必须存在：真实用户反馈里最扎的一句是「我像在被审问」。
   * 被追问到无话可说时，人不会因此照见自己，只会关掉页面。
   * 台阶把「卡住」从一次失败变成一次**被接住** —— 用户留在对话里，
   * 才有后面的复盘。
   */
  onHint: () => void;
  hintLoading: boolean;
  /** 服务端返回的话头；null = 当前没有显示中的提示 */
  hint: string | null;
  hintError: string | null;
  /** 收起提示（用户自己关掉，或一开始打字就自动收起） */
  onDismissHint: () => void;
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
  noticeAction,
  onHint,
  hintLoading,
  hint,
  hintError,
  onDismissHint,
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
      ? // 不再写「点上方继续」：「继续」按钮现在就在上面的提示条里
        '已暂停，先接着辩才能发言。'
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
        <div className="mb-2 flex items-center justify-between gap-3 rounded-xl bg-info-light px-3 py-2">
          <p className="text-xs leading-relaxed text-info">{notice}</p>
          {noticeAction ? (
            <Button
              variant="outline"
              className="shrink-0"
              loading={noticeAction.loading}
              onClick={noticeAction.onClick}
            >
              {noticeAction.label}
            </Button>
          ) : null}
        </div>
      ) : null}

      {/*
        台阶（AI 给的话头）。
        刻意做成**一块可以关掉的临时提示**，而不是一条辩论消息：
        它不是对话的一部分，写进记录会让 AI 下一轮变得小心翼翼，
        也会让复盘把一句提示当成用户说过的话。
      */}
      {hint ? (
        <div className="mb-2 rounded-xl bg-primary-light px-3 py-2.5">
          <div className="flex items-start justify-between gap-2">
            <p className="text-[11px] text-tertiary">给你一个话头</p>
            <button
              type="button"
              onClick={onDismissHint}
              aria-label="收起提示"
              className="-mr-1 -mt-0.5 shrink-0 rounded-md px-1.5 text-[11px] text-tertiary hover:bg-inset"
            >
              收起
            </button>
          </div>
          <p className="mt-1 text-[13px] leading-relaxed text-primary">{hint}</p>
        </div>
      ) : null}

      {hintError ? <p className="mb-2 text-xs text-danger">{hintError}</p> : null}

      <label className="sr-only" htmlFor="debate-composer">
        你的发言
      </label>
      <textarea
        id="debate-composer"
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
          // 一动手就收起提示：他已经知道怎么接了，提示继续留着会挡视线
          if (hint && event.target.value !== '') onDismissHint();
        }}
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

      {/*
        字数 + 台阶按钮同一行。
        台阶原来放在底部操作行里，和「这轮我放弃」挤在一起 ——
        390px 宽时两者会换行（实测「我卡住了，给我提示」独占一行，
        把「发送」挤到两行中间，整个输入区凭空高了 50px）。
        挪到计数行更合语义：它是「帮你写」的辅助，不是「结束这一轮」的操作。
      */}
      <div className="mt-1.5 flex items-center justify-between gap-2">
        {finished || paused ? (
          <span />
        ) : (
          <Button
            variant="ghost"
            size="sm"
            className="-ml-2"
            disabled={streaming}
            loading={hintLoading}
            onClick={onHint}
          >
            我卡住了，给我提示
          </Button>
        )}
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
          // 这一行只留「放弃」：台阶已经上移到计数行（见上面的说明）。
          // 两个文字操作挤在一行会在 390px 换行，把「发送」挤成两行之间的孤儿。
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

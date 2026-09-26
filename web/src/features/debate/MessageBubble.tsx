import { memo } from 'react';

import type { DebateMessage } from '@/api/types';
import { cn } from '@/lib/cn';

interface MessageBubbleProps {
  /** 完整的服务端消息；流式临时气泡传 role/round 即可 */
  message: Pick<DebateMessage, 'role' | 'round' | 'user_id' | 'nickname'>;
  /** 展示内容。流式气泡传已累积的增量文本 */
  content: string;
  /** 是不是当前用户发的：多人辩论里决定左右与昵称 */
  isOwn?: boolean;
  /** 正在逐字接收的临时气泡（末尾带光标） */
  streaming?: boolean;
}

/**
 * 消息气泡（配色方案 五·辩论中）：
 *   用户 --primary 底 + 白字；AI 白底 + --border-light 边 + 暖黑字；
 *   system 居中、只用中性灰，不抢视线。
 * 多人在场时 AI 气泡右上角标轮次，非本人的用户消息在气泡上方标昵称。
 *
 * memo：流式接收时每个 token 都会重渲染页面，已落库的历史消息 props 不变，
 * 靠 memo 跳过它们的重渲染，手机上逐字效果才不掉帧。
 */
export const MessageBubble = memo(function MessageBubble({
  message,
  content,
  isOwn = false,
  streaming = false,
}: MessageBubbleProps) {
  if (message.role === 'system') {
    return (
      <li className="flex justify-center">
        <p className="max-w-[90%] rounded-lg bg-elevated px-3 py-1.5 text-center text-xs leading-relaxed text-secondary">
          {content}
        </p>
      </li>
    );
  }

  const isUser = message.role === 'user';

  return (
    <li className={cn('flex flex-col', isUser && isOwn ? 'items-end' : 'items-start')}>
      {isUser ? (
        !isOwn && message.nickname ? (
          <span className="mb-1 px-1 text-[11px] text-tertiary">{message.nickname}</span>
        ) : null
      ) : (
        <span className="mb-1 flex items-center gap-1.5 px-1 text-[11px]">
          {/* AI 相关内容一律冷色（配色方案 十一·2） */}
          <span className="text-info">AI</span>
          <span className="text-tertiary">{message.round > 0 ? `第 ${message.round} 轮` : '开场'}</span>
        </span>
      )}

      <div
        aria-busy={streaming || undefined}
        className={cn(
          'max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2.5 text-[15px] leading-relaxed',
          isUser
            ? 'bg-primary text-on-brand'
            : 'border border-light bg-surface text-primary shadow-card',
          isUser && isOwn ? 'rounded-br-md' : 'rounded-bl-md',
        )}
      >
        {content === '' && streaming ? <TypingDots /> : content}
        {streaming && content !== '' ? (
          <span
            aria-hidden
            className="ml-0.5 inline-block h-[15px] w-[2px] translate-y-[2px] animate-pulse bg-info align-baseline"
          />
        ) : null}
      </div>
    </li>
  );
});

/** 还没收到第一个 token 时的等待态：三个点，不用骨架屏（骨架屏会显得页面在加载） */
function TypingDots() {
  return (
    <span className="flex items-center gap-1 py-1" aria-label="AI 正在输入">
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          className="h-1.5 w-1.5 animate-pulse rounded-full bg-info"
          style={{ animationDelay: `${index * 160}ms` }}
        />
      ))}
    </span>
  );
}

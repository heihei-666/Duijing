import { Button } from '@/components/common/Button';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/date';

import type { ReviewCardFull } from './api';

/**
 * 复盘卡片（配色方案 五·复盘卡片）。
 * 三块三色的色值来自设计文档，逐字采用：
 *   做得好     #EAF2EC / #C5DCC9 / #5B8C6B
 *   值得注意   #F7F0E4 / #E0D0B0 / #C4944A
 *   如果再来一次 #EAF0F6 / #C5D3E3 / #5A7FA8
 * 底色与标题色走 tokens（--success-light 等），边框色文档里没进 tokens，
 * 这里用精确色值，避免和文档漂移。
 */
const BLOCK_STYLE = {
  good: { label: '做得好', box: 'bg-success-light border-[#C5DCC9]', title: 'text-success' },
  notice: { label: '值得注意', box: 'bg-warning-light border-[#E0D0B0]', title: 'text-warning' },
  next_time: {
    label: '如果再来一次',
    box: 'bg-info-light border-[#C5D3E3]',
    title: 'text-info',
  },
} as const;

type BlockKey = keyof typeof BLOCK_STYLE;

const BLOCK_ORDER: BlockKey[] = ['good', 'notice', 'next_time'];

interface ReviewCardProps {
  review: ReviewCardFull;
  /** 只有发起人能关闭观察（后端同样是 403 拦截） */
  canDismiss: boolean;
  dismissing: boolean;
  error: string | null;
  onDismiss: () => void;
}

export function ReviewCard({ review, canDismiss, dismissing, error, onDismiss }: ReviewCardProps) {
  const dismissed = Boolean(review.observations_dismissed);

  // 最多展示 2 条，弱点在前、优势在后（方案 3.1：每场最多 1 优势 + 1 弱点）
  const observations = [...(review.observations ?? [])]
    .sort((a, b) => (a.type === b.type ? 0 : a.type === 'weakness' ? -1 : 1))
    .slice(0, 2);

  return (
    <section className="space-y-2.5" aria-label="复盘卡片">
      <header className="flex items-baseline justify-between gap-3 px-1">
        <h2 className="text-[15px] font-medium text-primary">这场辩论的复盘</h2>
        <span className="text-[11px] text-tertiary">{formatTimestamp(review.generated_at)}</span>
      </header>

      {BLOCK_ORDER.map((key) => {
        const style = BLOCK_STYLE[key];
        const block = review[key];
        if (!block?.content) return null;
        return (
          <div key={key} className={cn('rounded-2xl border px-4 py-3.5', style.box)}>
            <p className={cn('text-xs', style.title)}>{block.title || style.label}</p>
            <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-primary">
              {block.content}
            </p>
          </div>
        );
      })}

      {review.alternative_action ? (
        <div className="rounded-2xl border border-light bg-surface px-4 py-3.5">
          {/* AI 给的替代动作，标签用冷色；正文保持暖黑，保证可读性 */}
          <p className="text-xs text-info">替代动作</p>
          <p className="mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed text-primary">
            {review.alternative_action}
          </p>
        </div>
      ) : null}

      {observations.length > 0 ? (
        <div className="rounded-2xl border border-light bg-surface px-4 py-3.5">
          <p className="text-xs text-secondary">本轮观察</p>
          <ul className="mt-2 space-y-2.5">
            {observations.map((observation) => {
              const weakness = observation.type === 'weakness';
              return (
                <li key={observation.id} className="flex items-start gap-2">
                  <span
                    className={cn(
                      'mt-[3px] shrink-0 rounded-md border px-1.5 py-0.5 text-[10px] leading-4',
                      weakness
                        ? 'border-[#E0D0B0] bg-warning-light text-warning'
                        : 'border-sticky-ai bg-sticky-ai text-sticky-ai',
                    )}
                  >
                    {weakness ? '弱点' : '优势'}
                  </span>
                  <p className="text-[14px] leading-relaxed text-primary">{observation.content}</p>
                </li>
              );
            })}
          </ul>
          <p className="mt-2.5 text-[11px] text-tertiary">每场最多 1 条优势 + 1 条弱点。</p>

          {dismissed ? (
            <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
              已关闭本轮观察，这场不会产生弱点 / 优势数据。
            </p>
          ) : canDismiss ? (
            <Button
              variant="ghost"
              className="mt-1.5 -ml-2"
              loading={dismissing}
              onClick={onDismiss}
            >
              关闭本轮观察
            </Button>
          ) : (
            <p className="mt-2 text-[11px] leading-relaxed text-tertiary">
              观察只对发起人可见。
            </p>
          )}
        </div>
      ) : null}

      {error ? <p className="px-1 text-xs text-danger">{error}</p> : null}
    </section>
  );
}

import type { KeyboardEvent } from 'react';

import { cn } from '@/lib/cn';
import { formatMonthDay } from '@/lib/date';
import { AiIcon, LoopIcon, MoreIcon } from '@/features/weakness/icons';
import { STICKY_TONES } from '@/features/weakness/sticky';
import { SOURCE_LABELS, type WeaknessCardData } from '@/features/weakness/api';
import { useLongPress } from '@/features/weakness/useLongPress';

interface WeaknessNoteProps {
  card: WeaknessCardData;
  onOpen: (card: WeaknessCardData) => void;
  /** 长按或点右上角「···」时打开操作面板 */
  onAction: (card: WeaknessCardData) => void;
  /** 从首页 / 详情跳回来时高亮一下 */
  highlighted?: boolean;
}

/**
 * 一张弱点便签（方案 3.2 / 配色方案 三）。
 * 移动端：点击进详情，长按改状态；桌面端：长按同样是鼠标按住 480ms。
 */
export function WeaknessNote({ card, onOpen, onAction, highlighted = false }: WeaknessNoteProps) {
  const tone = STICKY_TONES[card.status];
  const press = useLongPress(
    () => onAction(card),
    () => onOpen(card),
  );

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onOpen(card);
  }

  return (
    <div className="relative px-0.5 py-0.5">
      <div
        {...press}
        role="button"
        tabIndex={0}
        aria-label={`${card.name}，${card.status === 'archived' ? '暂存' : '打开详情'}`}
        onKeyDown={handleKeyDown}
        style={tone.rotate ? { transform: 'rotate(var(--sticky-observing-rotate))' } : undefined}
        className={cn(
          'relative w-full cursor-pointer select-none rounded-xl px-4 py-3.5 text-left shadow-card',
          'transition-shadow hover:shadow-sheet',
          tone.card,
          card.status === 'archived' && 'opacity-60',
          highlighted && 'ring-2 ring-primary',
        )}
      >
        {tone.folded ? <FoldedCorner /> : null}

        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="text-[15px] font-medium leading-snug">{card.name}</h3>
            {card.description ? (
              <p className="mt-1 line-clamp-2 text-[13px] leading-relaxed opacity-80">
                {card.description}
              </p>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center">
            {tone.icon === 'ai' ? <AiIcon width={18} height={18} className="opacity-90" /> : null}
            {tone.icon === 'loop' ? (
              <LoopIcon width={16} height={16} className="text-brand" />
            ) : null}
            <button
              type="button"
              aria-label="更多操作"
              onPointerDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                onAction(card);
              }}
              className="-mr-2 flex h-11 w-10 items-center justify-center rounded-lg opacity-70 hover:bg-white/50 hover:opacity-100"
            >
              <MoreIcon />
            </button>
          </div>
        </div>

        <p className={cn('mt-2 text-[11px] leading-4', tone.meta)}>{metaText(card)}</p>
      </div>
    </div>
  );
}

/**
 * 便签角标（方案 3.2）：
 *   普通卡：演练 3 · 预案 1 · 12天前建
 *   AI 候选：来源：09-26 辩论房 · 1 次观察
 * AI 候选的「N 次观察」用近 30 天触发次数近似——契约里没有单独的观察次数字段。
 */
function metaText(card: WeaknessCardData): string {
  if (card.status === 'ai_candidate') {
    const observations =
      card.trigger_count_30d > 0 ? `${card.trigger_count_30d} 次观察` : '新观察';
    return `来源：${formatMonthDay(card.created_at.slice(0, 10))} ${SOURCE_LABELS[card.source]} · ${observations}`;
  }

  const parts = [
    `演练 ${card.drill_count}`,
    `预案 ${card.plan_count}`,
    `${card.days_since_created} 天前建`,
  ];

  const remaining = card.days_until_delete ?? card.expires_in_days;
  if (card.status === 'archived' && typeof remaining === 'number') {
    parts.push(`还有 ${remaining} 天删除`);
  }

  return parts.join(' · ');
}

/** 暂存便签的折角（配色方案 三：折角 --border-strong） */
function FoldedCorner() {
  return (
    <span
      aria-hidden
      className="absolute right-0 top-0 h-0 w-0 border-l-[16px] border-t-[16px] border-l-transparent"
      style={{ borderTopColor: 'var(--border-strong)' }}
    />
  );
}

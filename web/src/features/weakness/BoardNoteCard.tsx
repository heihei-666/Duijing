import { useDraggable } from '@dnd-kit/core';

import { cn } from '@/lib/cn';
import { WeaknessNote } from '@/features/weakness/WeaknessNote';
import type { WeaknessCardData } from '@/features/weakness/api';

export interface BoardNoteCardProps {
  card: WeaknessCardData;
  onOpen: (card: WeaknessCardData) => void;
  onAction: (card: WeaknessCardData) => void;
  /** 有请求在飞时锁住**所有**便签：并发拖拽会让回滚快照互相覆盖 */
  locked: boolean;
  /** 这一张正在提交 */
  pending: boolean;
  /** 从首页 / 详情跳回来时高亮一下 */
  highlighted?: boolean;
}

/**
 * 黑板上的一张便签（方案 3.2：Web 端黑板拖拽）。视觉仍然是 `WeaknessNote`，
 * 这里只加三样东西：拖拽容器、键盘拖拽把手、原位占位。
 *
 * 两个手感细节：
 *   1. PointerSensor 的激活距离是 12px，比 `useLongPress` 的 8px 容差大——
 *      鼠标一动就会先取消长按计时器，不会出现「拖到一半弹出操作面板」。
 *   2. 便签本体在拖动时用 `invisible` 留在原位（不是卸载），
 *      所以高度、间距都不变，同区的其它便签不会跳。
 */
export function BoardNoteCard({
  card,
  onOpen,
  onAction,
  locked,
  pending,
  highlighted = false,
}: BoardNoteCardProps) {
  // AI 观察候选是 AI 给的建议：只能「加入」或「忽略」，不可拖出
  const draggable = card.status !== 'ai_candidate';

  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({
    id: `note-${card.id}`,
    data: { zone: card.status, cardId: card.id, name: card.name },
    disabled: !draggable || locked,
  });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      className={cn('group relative', isDragging && 'z-20')}
      // 稳定钩子：调试 / e2e 用它定位「哪张便签在哪个区」
      data-board-note={card.id}
    >
      <div className={cn(isDragging && 'invisible')}>
        <WeaknessNote
          card={card}
          onOpen={onOpen}
          onAction={onAction}
          highlighted={highlighted}
        />
      </div>

      {/* 原位占位：淡虚线框，尺寸由上面那份 invisible 的便签撑住，不产生布局跳动 */}
      {isDragging ? (
        <div
          aria-hidden
          className="absolute inset-0 rounded-xl border border-dashed border-strong opacity-60"
          style={{ backgroundColor: 'var(--bg-inset)' }}
        />
      ) : null}

      {draggable ? (
        <button
          ref={setActivatorNodeRef}
          {...attributes}
          type="button"
          aria-label={`拖动便签「${card.name}」改变状态`}
          title="拖动改变状态（键盘：空格拿起，方向键换区，空格放下）"
          className={cn(
            'absolute left-0 top-1/2 z-10 flex h-9 w-4 -translate-y-1/2 cursor-grab items-center justify-center rounded-md',
            'touch-none text-tertiary opacity-30 transition-opacity',
            'hover:bg-elevated hover:opacity-100 focus-visible:opacity-100',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary',
            'active:cursor-grabbing',
            !locked && !isDragging && 'group-hover:opacity-100',
            (isDragging || locked) && 'cursor-default opacity-30',
          )}
        >
          {pending ? (
            <span
              aria-hidden
              className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent"
            />
          ) : (
            <GripIcon />
          )}
        </button>
      ) : null}
    </div>
  );
}

/** 拖拽把手图标：两列圆点，风格同 `features/weakness/icons.tsx`（currentColor） */
function GripIcon() {
  return (
    <svg width={10} height={16} viewBox="0 0 10 16" fill="currentColor" aria-hidden focusable={false}>
      <circle cx="3" cy="3" r="1.25" />
      <circle cx="7" cy="3" r="1.25" />
      <circle cx="3" cy="8" r="1.25" />
      <circle cx="7" cy="8" r="1.25" />
      <circle cx="3" cy="13" r="1.25" />
      <circle cx="7" cy="13" r="1.25" />
    </svg>
  );
}

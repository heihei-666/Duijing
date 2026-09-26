import { useCallback, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';

import type { WeaknessStatus } from '@/api/types';
import { cn } from '@/lib/cn';
import { EmptyState } from '@/components/common/EmptyState';
import { WeaknessNote } from '@/features/weakness/WeaknessNote';
import { BoardNoteCard } from '@/features/weakness/BoardNoteCard';
import { AiIcon, TrashIcon } from '@/features/weakness/icons';
import {
  BOARD_ANNOUNCEMENTS,
  BOARD_SCREEN_READER_INSTRUCTIONS,
  BOARD_STATUS_ORDER,
  boardCollisionDetection,
  boardKeyboardCoordinates,
  boardZoneId,
  canDropOnStatus,
  dropRejectReason,
  zoneStatusOf,
  type WeaknessGroups,
} from '@/features/weakness/boardDrag';
import type { WeaknessCardData } from '@/features/weakness/api';

export interface WeaknessBoardProps {
  groups: WeaknessGroups;
  onOpen: (card: WeaknessCardData) => void;
  onAction: (card: WeaknessCardData) => void;
  /** 拖拽落点 → 状态流转（乐观更新 + 失败回滚由页面统一处理） */
  onMove: (card: WeaknessCardData, target: WeaknessStatus) => void;
  /** 非法落点的一句话提示 */
  onReject: (message: string) => void;
  /** 有请求在飞：锁住拖拽，避免并发回滚互相覆盖 */
  locked: boolean;
  pendingId: number | null;
  justCreatedId: number | null;
}

interface ColumnSpec {
  status: WeaknessStatus;
  title: string;
  hint: string;
  emptyTitle: string;
  emptyHint: string;
  icon?: ReactNode;
}

const COLUMNS: ColumnSpec[] = [
  {
    status: 'ai_candidate',
    title: 'AI 观察候选',
    hint: 'AI 给的观察，只能加入或忽略',
    emptyTitle: '暂时没有新的观察',
    emptyHint: '辩一轮，或记几笔事件卡。',
    icon: <AiIcon width={14} height={14} className="text-info" />,
  },
  {
    status: 'observing',
    title: '观察中',
    hint: '拖到「改善中」开始练',
    emptyTitle: '还没有在观察的弱点',
    emptyHint: '把 AI 候选加入观察，或自己新建一条。',
  },
  {
    status: 'improving',
    title: '改善中',
    hint: '正在练的，可拖回「观察中」',
    emptyTitle: '还没有在改善的弱点',
    emptyHint: '给弱点建一条回环，它就会进到这里。',
  },
];

const TRASH_SPEC = {
  status: 'archived' as WeaknessStatus,
  title: '垃圾桶',
  hint: '拖进来＝移入暂存（保留 60 天），拖出去＝恢复到观察中',
};

const noop = () => undefined;

/**
 * 弱点墙黑板（方案 3.2 / 4.1：Web 端黑板拖拽，dnd-kit）。
 * 只在宽屏渲染；窄屏仍然是列表态 + 分区折叠（见 WeaknessesPage）。
 *
 * 数据是「受控」的：拖拽只负责把落点翻译成一次 onMove 调用，
 * 便签搬到哪儿由页面的乐观更新决定，失败时页面把便签放回去。
 */
export function WeaknessBoard({
  groups,
  onOpen,
  onAction,
  onMove,
  onReject,
  locked,
  pendingId,
  justCreatedId,
}: WeaknessBoardProps) {
  const [activeCard, setActiveCard] = useState<WeaknessCardData | null>(null);
  // 拖拽开始/结束之间要读最新的卡：state 用于渲染，ref 用于逻辑，避免闭包读到旧值
  const activeCardRef = useRef<WeaknessCardData | null>(null);

  const sensors = useSensors(
    // 12px > useLongPress 的 8px 容差：鼠标一动就先取消长按计时器，
    // 不会出现「拖到一半弹出操作面板」；纯点击仍然走便签自己的 onClick（进详情）。
    useSensor(PointerSensor, { activationConstraint: { distance: 12 } }),
    // 键盘拖拽（无障碍硬要求）：空格/回车拿起，方向键换区
    useSensor(KeyboardSensor, { coordinateGetter: boardKeyboardCoordinates }),
  );

  const cardById = useMemo(() => {
    const map = new Map<number, WeaknessCardData>();
    for (const status of BOARD_STATUS_ORDER) {
      for (const card of groups[status] ?? []) map.set(card.id, card);
    }
    return map;
  }, [groups]);

  const handleDragStart = useCallback(
    (event: DragStartEvent) => {
      const cardId = event.active.data.current?.cardId;
      const card = typeof cardId === 'number' ? cardById.get(cardId) ?? null : null;
      activeCardRef.current = card;
      setActiveCard(card);
    },
    [cardById],
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const card = activeCardRef.current;
      activeCardRef.current = null;
      setActiveCard(null);
      if (!card) return;

      const target = zoneStatusOf(event.over?.data.current);
      // 丢在黑板外（over 为 null）＝取消，便签自己回到原位，不发任何请求
      if (!target) return;

      const reason = dropRejectReason(card.status, target);
      if (reason) {
        // 「已经在这个分区里」不需要打扰用户，其余非法落点给一句话
        if (card.status !== target) onReject(reason);
        return;
      }

      onMove(card, target);
    },
    [onMove, onReject],
  );

  const handleDragCancel = useCallback(() => {
    activeCardRef.current = null;
    setActiveCard(null);
  }, []);

  const activeStatus = activeCard?.status ?? null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollisionDetection}
      accessibility={{
        announcements: BOARD_ANNOUNCEMENTS,
        screenReaderInstructions: BOARD_SCREEN_READER_INSTRUCTIONS,
      }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <section aria-label="弱点黑板" className="space-y-2">
        <p className="text-[11px] leading-4 text-tertiary">
          拖拽便签改变状态。键盘操作：Tab 到便签左侧把手，空格拿起，方向键换区，空格放下。
        </p>

        {/* 黑板底色比页面深一档，和便签的白 / 暖黄拉开层次 */}
        <div className="rounded-2xl bg-inset p-3">
          <div className="grid grid-cols-3 gap-3">
            {COLUMNS.map((column) => (
              <BoardColumn
                key={column.status}
                spec={column}
                cards={groups[column.status] ?? []}
                activeStatus={activeStatus}
                locked={locked}
                pendingId={pendingId}
                justCreatedId={justCreatedId}
                onOpen={onOpen}
                onAction={onAction}
                onMove={onMove}
              />
            ))}
          </div>

          <BoardTrash
            cards={groups.archived ?? []}
            activeStatus={activeStatus}
            locked={locked}
            pendingId={pendingId}
            justCreatedId={justCreatedId}
            onOpen={onOpen}
            onAction={onAction}
          />
        </div>
      </section>

      {/*
        拖动时整块便签跟着光标（轻微旋转 + 抬起阴影）。
        dropAnimation 关掉：跨区移动时便签落点已经变了，飞回旧位置的动画会误导。
      */}
      <DragOverlay dropAnimation={null} style={{ pointerEvents: 'none' }}>
        {activeCard ? (
          <div
            aria-hidden
            className="pointer-events-none rotate-2 shadow-[0_14px_30px_rgba(44,42,38,0.22)]"
          >
            <WeaknessNote card={activeCard} onOpen={noop} onAction={noop} />
          </div>
        ) : null}
      </DragOverlay>
    </DndContext>
  );
}

interface BoardColumnProps {
  spec: ColumnSpec;
  cards: WeaknessCardData[];
  activeStatus: WeaknessStatus | null;
  locked: boolean;
  pendingId: number | null;
  justCreatedId: number | null;
  onOpen: (card: WeaknessCardData) => void;
  onAction: (card: WeaknessCardData) => void;
  onMove: (card: WeaknessCardData, target: WeaknessStatus) => void;
}

/** 一个分区（droppable）。AI 候选区也是 droppable，但永远不接受拖入——用来给「放不下」的反馈。 */
function BoardColumn({
  spec,
  cards,
  activeStatus,
  locked,
  pendingId,
  justCreatedId,
  onOpen,
  onAction,
  onMove,
}: BoardColumnProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: boardZoneId(spec.status),
    data: { zone: spec.status },
  });

  const dragging = activeStatus !== null;
  const accepted = dragging ? canDropOnStatus(activeStatus, spec.status) : false;
  const highlight = isOver && accepted;
  const rejecting = isOver && dragging && !accepted;

  return (
    <section
      ref={setNodeRef}
      aria-label={`${spec.title}（${cards.length} 条）`}
      className={cn(
        'flex min-h-[240px] flex-col rounded-xl border-2 border-dashed p-2 transition-colors',
        highlight ? 'border-primary bg-primary-light' : 'border-light bg-base',
        rejecting && 'border-strong bg-elevated',
      )}
    >
      <header className="px-1 pb-2">
        <p className="flex items-center gap-1.5 text-[13px] text-secondary">
          {spec.icon}
          <span className="min-w-0 flex-1 truncate">{spec.title}</span>
          <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-tertiary">
            {cards.length}
          </span>
        </p>
        <p className="mt-1 text-[11px] leading-4 text-tertiary">
          {rejecting
            ? activeStatus === spec.status
              ? '它已经在这个分区里了'
              : '这里放不下这张便签'
            : spec.hint}
        </p>
      </header>

      <div className="max-h-[58vh] flex-1 overflow-y-auto px-1 pb-1 pt-0.5">
        {cards.length === 0 ? (
          <EmptyState title={spec.emptyTitle} hint={spec.emptyHint} />
        ) : (
          <ul className="space-y-2.5">
            {cards.map((card) => (
              <li key={card.id} className="space-y-1.5">
                <BoardNoteCard
                  card={card}
                  onOpen={onOpen}
                  onAction={onAction}
                  locked={locked}
                  pending={pendingId === card.id}
                  highlighted={justCreatedId === card.id}
                />
                {spec.status === 'ai_candidate' ? (
                  <CandidateActions
                    card={card}
                    locked={locked}
                    pending={pendingId === card.id}
                    onMove={onMove}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}

interface CandidateActionsProps {
  card: WeaknessCardData;
  locked: boolean;
  pending: boolean;
  onMove: (card: WeaknessCardData, target: WeaknessStatus) => void;
}

/**
 * AI 观察候选的两个动作（方案 3.2：AI 候选只能接受或忽略）。
 * 便签本身不可拖拽，所以这两个按钮必须留在卡片上——不能只藏在长按面板里。
 */
function CandidateActions({ card, locked, pending, onMove }: CandidateActionsProps) {
  return (
    <div className="flex gap-1.5 px-0.5">
      <button
        type="button"
        disabled={locked}
        onClick={() => onMove(card, 'observing')}
        className="flex h-8 flex-1 items-center justify-center rounded-lg bg-primary text-[11px] text-on-brand transition-colors hover:bg-primary-hover disabled:opacity-60"
      >
        {pending ? '处理中…' : '加入观察中'}
      </button>
      <button
        type="button"
        disabled={locked}
        onClick={() => onMove(card, 'archived')}
        className="flex h-8 items-center justify-center rounded-lg border border-light bg-surface px-2 text-[11px] text-secondary transition-colors hover:bg-elevated disabled:opacity-60"
      >
        忽略
      </button>
    </div>
  );
}

interface BoardTrashProps {
  cards: WeaknessCardData[];
  activeStatus: WeaknessStatus | null;
  locked: boolean;
  pendingId: number | null;
  justCreatedId: number | null;
  onOpen: (card: WeaknessCardData) => void;
  onAction: (card: WeaknessCardData) => void;
}

/**
 * 垃圾桶（droppable）。用 --danger 系但保持降饱和（不加任何透明度修饰符，
 * 直接吃 #B85C5C 这个砖红）；暂存的便签停在这里，拖出去就是恢复。
 */
function BoardTrash({
  cards,
  activeStatus,
  locked,
  pendingId,
  justCreatedId,
  onOpen,
  onAction,
}: BoardTrashProps) {
  const { setNodeRef, isOver } = useDroppable({
    id: boardZoneId(TRASH_SPEC.status),
    data: { zone: TRASH_SPEC.status },
  });

  const dragging = activeStatus !== null;
  const accepted = dragging ? canDropOnStatus(activeStatus, TRASH_SPEC.status) : false;
  const highlight = isOver && accepted;

  return (
    <section
      ref={setNodeRef}
      aria-label={`垃圾桶（${cards.length} 条暂存）`}
      className={cn(
        'mt-3 rounded-xl border-2 border-dashed border-danger p-2.5 transition-colors',
        highlight ? 'bg-danger-light' : 'bg-base',
      )}
    >
      <header className="flex flex-wrap items-center gap-2">
        <TrashIcon width={15} height={15} className="text-danger" />
        <span className="text-[13px] text-danger">{TRASH_SPEC.title}</span>
        <span className="rounded-md bg-elevated px-1.5 py-0.5 text-[11px] tabular-nums text-tertiary">
          {cards.length}
        </span>
        <span className="ml-auto text-[11px] text-tertiary">{TRASH_SPEC.hint}</span>
      </header>

      {cards.length === 0 ? (
        <p className="mt-2 px-0.5 text-[11px] text-tertiary">
          {highlight ? '松手就移入暂存，60 天内随时能拖回来。' : '垃圾桶是空的。'}
        </p>
      ) : (
        <ul className="mt-2 flex gap-2.5 overflow-x-auto px-0.5 pb-1 pt-0.5">
          {cards.map((card) => (
            <li key={card.id} className="w-[180px] shrink-0">
              <BoardNoteCard
                card={card}
                onOpen={onOpen}
                onAction={onAction}
                locked={locked}
                pending={pendingId === card.id}
                highlighted={justCreatedId === card.id}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

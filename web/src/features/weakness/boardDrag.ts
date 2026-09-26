/**
 * 弱点墙「黑板」的拖拽契约层（方案 3.2 / 4.1：Web 端黑板拖拽，技术栈 dnd-kit）。
 *
 * 这个文件只做三件事，都不碰 DOM：
 *   1. 落点 → 接口 的映射（**整个黑板最容易做错的地方**，见 moveWeaknessByDrop）
 *   2. 乐观更新与回滚用的分区搬运（placeCardInGroups）
 *   3. 键盘拖拽的坐标策略 + 碰撞策略 + 中文朗读文案
 *
 * 为什么归档 / 恢复必须走各自的接口：
 *   后端刻意拒绝 `PATCH /weaknesses/{id} {"status":"archived"}`（400），
 *   因为归档要顺带写 60 天删除倒计时与归档流水；恢复同理，服务端固定恢复成
 *   observing 并保留 30 天触发计数。拖拽只是换了个入口，落点语义必须和
 *   WeaknessActionsSheet 完全一致。
 */

import {
  KeyboardCode,
  pointerWithin,
  closestCenter,
  rectIntersection,
  type Announcements,
  type CollisionDetection,
  type KeyboardCoordinateGetter,
} from '@dnd-kit/core';

import type { WeaknessStatus } from '@/api/types';
import {
  archiveWeakness,
  restoreWeakness,
  updateWeakness,
  WEAKNESS_STATUS_LABELS,
  type WeaknessCardData,
  type WeaknessGroupsData,
} from '@/features/weakness/api';

/** 弱点墙四区（黑板上的视觉顺序：三列 + 底部垃圾桶） */
export const BOARD_STATUS_ORDER: WeaknessStatus[] = [
  'ai_candidate',
  'observing',
  'improving',
  'archived',
];

export type WeaknessGroups = WeaknessGroupsData['groups'];

/** 分区作为 dnd-kit 的 droppable id */
export function boardZoneId(status: WeaknessStatus): string {
  return `zone-${status}`;
}

const ZONE_STATUS_SET = new Set<string>(BOARD_STATUS_ORDER);

/** 从 `over.data.current` / `active.data.current` 里取出分区状态；取不到返回 null */
export function zoneStatusOf(data: Record<string, unknown> | undefined): WeaknessStatus | null {
  const zone = data?.zone;
  return typeof zone === 'string' && ZONE_STATUS_SET.has(zone) ? (zone as WeaknessStatus) : null;
}

/** 分区名（垃圾桶不叫「暂存」，拖拽面板上用大白话） */
export function boardZoneLabel(status: WeaknessStatus): string {
  return status === 'archived' ? '垃圾桶' : WEAKNESS_STATUS_LABELS[status];
}

/* ------------------------------------------------------------ 落点 → 接口 */

/** 一次拖拽落地的结果 */
export interface BoardMoveOutcome {
  /** 服务端最终落在哪个状态（失败回滚时也要用它来定位） */
  landed: WeaknessStatus;
  /** 给用户的一句反馈 */
  message: string;
}

/**
 * 移动失败。`landed` 表示「服务端其实已经改到了哪一步」：
 *   null      → 服务端没有任何变化，界面整个回滚到拖拽前
 *   'observing' → 例如「恢复成功、接着改改善中失败」，只能回滚到观察中
 */
export class BoardMoveError extends Error {
  readonly landed: WeaknessStatus | null;

  constructor(message: string, landed: WeaknessStatus | null = null) {
    super(message);
    this.name = 'BoardMoveError';
    this.landed = landed;
  }
}

function reasonOf(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message ? cause.message : fallback;
}

/**
 * 拖拽落点 → 请求。**逐条对照，不要「顺手」改成一个通用 PATCH**：
 *
 *   拖到        请求                                        后端行为
 *   观察中      PATCH /api/weaknesses/{id} {"status":"observing"}   退回观察
 *   改善中      PATCH /api/weaknesses/{id} {"status":"improving"}   进入改善
 *   垃圾桶      POST  /api/weaknesses/{id}/archive          写 60 天倒计时 + 归档流水
 *   从垃圾桶出来 POST  /api/weaknesses/{id}/restore          恢复成 observing，触发计数保留
 *   AI 候选区   不可放置（AI 候选本身也不可拖出）
 *
 * 特别注意：**不能**用 `PATCH {"status":"archived"}` 代替归档接口，后端会返回 400。
 */
export async function moveWeaknessByDrop(
  card: WeaknessCardData,
  target: WeaknessStatus,
): Promise<BoardMoveOutcome> {
  if (target === 'ai_candidate') {
    // 前端不会主动发起（AI 候选由系统生成），留一道保险
    throw new BoardMoveError('AI 观察候选由系统给出，不能手动移入。');
  }

  // 1) 拖进垃圾桶 → 归档接口
  if (target === 'archived') {
    try {
      const result = await archiveWeakness(card.id);
      return { landed: 'archived', message: result.note ?? '已移入暂存，60 天后自动删除' };
    } catch (cause) {
      throw new BoardMoveError(reasonOf(cause, '移入暂存失败，请稍后再试'));
    }
  }

  // 2) 从垃圾桶拖回黑板 → 恢复接口（服务端固定恢复成 observing）
  if (card.status === 'archived') {
    try {
      await restoreWeakness(card.id);
    } catch (cause) {
      throw new BoardMoveError(reasonOf(cause, '恢复失败，请稍后再试'));
    }

    if (target === 'observing') {
      return { landed: 'observing', message: '已从垃圾桶恢复到观察中' };
    }

    try {
      await updateWeakness(card.id, { status: 'improving' });
      return { landed: 'improving', message: '已从垃圾桶恢复到改善中' };
    } catch (cause) {
      // 恢复已经生效了：只回滚到「观察中」，不能装作它还躺在垃圾桶里
      throw new BoardMoveError(
        `已恢复到观察中，但没能移到改善中：${reasonOf(cause, '请稍后再试')}`,
        'observing',
      );
    }
  }

  // 3) 观察中 ↔ 改善中 → PATCH status
  try {
    await updateWeakness(card.id, { status: target });
    return {
      landed: target,
      // AI 候选被接受说「加入」，观察中 ↔ 改善中之间才说「移到 / 退回」
      message:
        target === 'improving'
          ? '已移到改善中'
          : card.status === 'ai_candidate'
            ? '已加入观察中'
            : '已退回观察中',
    };
  } catch (cause) {
    throw new BoardMoveError(reasonOf(cause, '移动失败，请稍后再试'));
  }
}

/* ---------------------------------------------------- 落点合法性与提示语 */

/**
 * 便签能不能放到这个区。
 * AI 观察候选是 AI 给的建议，用户只能「加入」（接受为观察中）或忽略，
 * 不能拖进改善中——所以它既不可拖出，AI 区也不接受任何拖入。
 */
export function canDropOnStatus(from: WeaknessStatus, target: WeaknessStatus): boolean {
  if (from === 'ai_candidate') return false;
  if (target === 'ai_candidate') return false;
  return from !== target;
}

/** 不允许的落点给一句话；允许则返回 null */
export function dropRejectReason(from: WeaknessStatus, target: WeaknessStatus): string | null {
  if (from === 'ai_candidate') return 'AI 观察候选不能拖动，请用「加入观察中」或「忽略」。';
  if (target === 'ai_candidate') return 'AI 候选由系统给出，不能手动移入。';
  if (from === target) return '它已经在这个分区里了。';
  return null;
}

/* ------------------------------------------------- 乐观更新 / 失败回滚 */

/**
 * 把一张卡搬进目标分区（其余分区里移除）。
 * 乐观更新用它，回滚时也用同一个函数把便签放回去，保证两边逻辑一致。
 */
export function placeCardInGroups(
  groups: WeaknessGroups,
  card: WeaknessCardData,
  status: WeaknessStatus,
): WeaknessGroups {
  const next = {} as WeaknessGroups;
  for (const key of BOARD_STATUS_ORDER) {
    next[key] = (groups[key] ?? []).filter((item) => item.id !== card.id);
  }
  next[status] = [restatusCard(card, status), ...next[status]];
  return next;
}

/**
 * 改状态时补齐展示需要的字段：
 *   归档：先按方案写 60 天，真实值等 `load(true)` 回来后覆盖；
 *   恢复：清掉归档痕迹，否则角标会继续显示「还有 N 天删除」。
 */
function restatusCard(card: WeaknessCardData, status: WeaknessStatus): WeaknessCardData {
  if (card.status === status) return card;

  if (status === 'archived') {
    return {
      ...card,
      status,
      archived_at: new Date().toISOString(),
      delete_after: null,
      days_until_delete: card.days_until_delete ?? 60,
    };
  }

  return {
    ...card,
    status,
    archived_at: null,
    delete_after: null,
    days_until_delete: null,
    expires_in_days: null,
  };
}

/* ------------------------------------------------------------ 拖拽策略 */

/**
 * 碰撞策略：
 *   鼠标 / 触摸 → 指针落在哪个区就是哪个区（pointerWithin），落在列间空隙时取最近的分区
 *   键盘        → 没有指针坐标，用矩形相交判断（键盘坐标会把便签挪进目标区里）
 */
export const boardCollisionDetection: CollisionDetection = (args) => {
  if (args.pointerCoordinates) {
    const within = pointerWithin(args);
    if (within.length > 0) return within;
    return closestCenter(args);
  }
  return rectIntersection(args);
};

/**
 * 键盘拖拽坐标：默认实现是按 25px 一格挪，跨过一整块黑板要按几十次。
 * 这里改成「方向键 = 跳到上/下一个分区」，落点固定在分区靠上的位置
 * （和列表里「新便签插到最前面」一致，也不会被长列表顶出屏幕）。
 */
export const boardKeyboardCoordinates: KeyboardCoordinateGetter = (event, { context }) => {
  const forward = event.code === KeyboardCode.Right || event.code === KeyboardCode.Down;
  const backward = event.code === KeyboardCode.Left || event.code === KeyboardCode.Up;
  if (!forward && !backward) return undefined;

  const { collisionRect, droppableRects } = context;
  if (!collisionRect) return undefined;

  const zones = BOARD_STATUS_ORDER.flatMap((status) => {
    const rect = droppableRects.get(boardZoneId(status));
    return rect ? [{ status, rect }] : [];
  });
  if (zones.length === 0) return undefined;

  const center = {
    x: collisionRect.left + collisionRect.width / 2,
    y: collisionRect.top + collisionRect.height / 2,
  };

  // 当前在哪个区：中心点先看包含关系，不在任何区里（比如刚从列间空隙拿起）就取最近的
  let index = zones.findIndex(
    ({ rect }) =>
      center.x >= rect.left &&
      center.x <= rect.right &&
      center.y >= rect.top &&
      center.y <= rect.bottom,
  );
  if (index < 0) {
    let bestDistance = Number.POSITIVE_INFINITY;
    index = 0;
    zones.forEach(({ rect }, position) => {
      const dx = rect.left + rect.width / 2 - center.x;
      const dy = rect.top + rect.height / 2 - center.y;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) {
        bestDistance = distance;
        index = position;
      }
    });
  }

  const step = forward ? 1 : -1;
  const target = zones[Math.min(zones.length - 1, Math.max(0, index + step))].rect;
  const targetCenterY =
    target.top + Math.min(target.height / 2, collisionRect.height / 2 + 20);

  return {
    x: target.left + target.width / 2 - collisionRect.width / 2,
    y: targetCenterY - collisionRect.height / 2,
  };
};

/* --------------------------------------------------------- 无障碍朗读 */

/** 屏幕阅读器操作说明（挂在每个拖拽把手的 aria-describedby 上） */
export const BOARD_SCREEN_READER_INSTRUCTIONS = {
  draggable:
    '按空格或回车拿起便签，用左右方向键切换分区，再按空格或回车放下，按 Esc 取消。',
};

function dragLabel(data: Record<string, unknown> | undefined): string {
  const name = data?.name;
  return typeof name === 'string' && name ? `便签「${name}」` : '便签';
}

/** 拖拽过程中的中文播报（dnd-kit 默认是英文） */
export const BOARD_ANNOUNCEMENTS: Announcements = {
  onDragStart: ({ active }) =>
    `已拿起${dragLabel(active.data.current)}。用左右方向键切换分区，空格或回车放下，Esc 取消。`,
  onDragOver: ({ active, over }) => {
    const target = zoneStatusOf(over?.data.current);
    if (!target) return '不在任何分区上，继续用方向键换一个分区。';
    const from = zoneStatusOf(active.data.current);
    if (from && !canDropOnStatus(from, target)) {
      return `${boardZoneLabel(target)}放不下这张便签。`;
    }
    return `当前在「${boardZoneLabel(target)}」上方，空格放下。`;
  },
  onDragEnd: ({ active, over }) => {
    const target = zoneStatusOf(over?.data.current);
    if (!target) return `${dragLabel(active.data.current)}已回到原位。`;
    return `${dragLabel(active.data.current)}已放到「${boardZoneLabel(target)}」。`;
  },
  onDragCancel: ({ active }) => `已取消，${dragLabel(active.data.current)}回到原位。`,
};

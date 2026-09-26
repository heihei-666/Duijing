/**
 * 资产模块的数据访问层（优势库 / 原则库 / 事件卡 / 设置）。
 *
 * 与 `features/weakness/api.ts` 同样的理由：列表接口的查询参数是 `status_filter`
 * （client.ts 传的是 `status`），且多个响应是包了一层的（`{ advantages }`、
 * `{ principle }`、`{ cards }`、`{ deleted }`…）。
 * 本次不允许改 `client.ts` / `types.ts`，所以复用 client.ts 导出的 `apiRequest`
 * ——同一套 credentials / 错误解析 / 401 处理，只补类型。
 */

import { apiRequest } from '@/api/client';
import type {
  AdvantageStatus,
  EventCardResult,
  LoopStatus,
  PrincipleConfidence,
  PrincipleSourceType,
  PrincipleStatus,
  WeaknessStatus,
} from '@/api/types';
import type { WeaknessDetailData, WeaknessGroupsData } from '@/features/weakness/api';

/* ------------------------------------------------------------------ 优势 */

export interface AdvantageData {
  id: number;
  name: string;
  source: 'ai' | 'user';
  source_id: number | null;
  verified: boolean;
  /** 后端还有 'removed'（移除留痕，AI 不再重复入库同一标签） */
  status: AdvantageStatus | 'removed';
  created_at: string;
  archived_at: string | null;
}

/**
 * `status_filter` 支持 `archived` / `removed`（后端 `list_advantages` 原样透传给 `in_`）。
 * `types.ts` 的 `AdvantageStatus` 里没有 `removed`，而那个文件不允许改，所以这里放宽参数类型。
 */
export function listAdvantages(
  statuses: Array<AdvantageStatus | 'removed'>,
): Promise<{ advantages: AdvantageData[]; total: number; pending_count: number }> {
  return apiRequest<{ advantages: AdvantageData[]; total: number; pending_count: number }>(
    '/advantages',
    { query: { status_filter: statuses } },
  );
}

export function confirmAdvantage(id: number): Promise<{ advantage: AdvantageData }> {
  return apiRequest<{ advantage: AdvantageData }>(`/advantages/${id}/confirm`, { method: 'POST' });
}

export function removeAdvantage(id: number): Promise<{ ok: boolean; note?: string }> {
  return apiRequest<{ ok: boolean; note?: string }>(`/advantages/${id}/remove`, { method: 'POST' });
}

/**
 * 归档优势（已确认 → 已归档）。
 *
 * ⚠ 后端**没有** `POST /api/advantages/{id}/archive`：`app/api/advantages.py` 只暴露
 * confirm / remove / restore 三个动作，`archive` 只存在于定时任务 `archive_stale()` 内部
 * （待确认超 30 天自动归档）。所以「归档」这个动作只能落到 `remove` 上——
 * 它本来就是「移出正常列表 + 留痕」的语义（status=removed，AI 不再重复入库同一标签），
 * 而 `restore` 同样接受 `removed`，恢复后回到 pending。
 *
 * 保留独立的 `archiveAdvantage()` 而不是让调用方直接写 `removeAdvantage()`：
 * 语义在调用处可见（待确认→移除 / 已确认→归档），
 * 后端将来补上 `/archive` 时只需改这一个函数体。
 */
export function archiveAdvantage(id: number): Promise<{ ok: boolean; note?: string }> {
  return apiRequest<{ ok: boolean; note?: string }>(`/advantages/${id}/remove`, { method: 'POST' });
}

/** 恢复优势：archived / removed → pending（待确认） */
export function restoreAdvantage(id: number): Promise<{ advantage: AdvantageData }> {
  return apiRequest<{ advantage: AdvantageData }>(`/advantages/${id}/restore`, { method: 'POST' });
}

/* ------------------------------------------------------------------ 原则 */

export interface PrincipleData {
  id: number;
  content: string;
  source_type: PrincipleSourceType;
  source_id: number | null;
  /** 后端还有 'ignored'（忽略留痕） */
  status: PrincipleStatus | 'ignored';
  confidence: PrincipleConfidence;
  pinned: boolean;
  linked_loop_ids: number[];
  linked_loops: Array<{ id: number; trigger_scene: string }>;
  created_at: string;
  updated_at: string;
}

/** 同优势：`types.ts` 的 `PrincipleStatus` 里没有 `ignored`，这里放宽参数类型 */
export function listPrinciples(
  statuses: Array<PrincipleStatus | 'ignored'>,
): Promise<{ principles: PrincipleData[]; total: number; candidate_count: number }> {
  return apiRequest<{ principles: PrincipleData[]; total: number; candidate_count: number }>(
    '/principles',
    { query: { status_filter: statuses } },
  );
}

export function createPrinciple(payload: {
  content: string;
  confidence?: PrincipleConfidence;
  linked_loop_ids?: number[];
}): Promise<{ principle: PrincipleData }> {
  return apiRequest<{ principle: PrincipleData }>('/principles', { method: 'POST', body: payload });
}

export function updatePrinciple(
  id: number,
  payload: { content?: string; pinned?: boolean; linked_loop_ids?: number[] },
): Promise<{ principle: PrincipleData }> {
  return apiRequest<{ principle: PrincipleData }>(`/principles/${id}`, {
    method: 'PATCH',
    body: payload,
  });
}

export function confirmPrinciple(id: number): Promise<{ principle: PrincipleData }> {
  return apiRequest<{ principle: PrincipleData }>(`/principles/${id}/confirm`, { method: 'POST' });
}

/** 忽略留痕：AI 不再重复推同一条 */
export function ignorePrinciple(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/principles/${id}/ignore`, { method: 'POST' });
}

/** 归档：启用中 → 已归档（`POST /api/principles/{id}/archive`，只返回 ok） */
export function archivePrinciple(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/principles/${id}/archive`, { method: 'POST' });
}

/** 恢复原则：archived / ignored → active（启用中） */
export function restorePrinciple(id: number): Promise<{ principle: PrincipleData }> {
  return apiRequest<{ principle: PrincipleData }>(`/principles/${id}/restore`, { method: 'POST' });
}

/* ---------------------------------------------------------------- 事件卡 */

export interface EventCardData {
  id: number;
  content: string;
  linked_loop_ids: number[];
  linked_loops: Array<{ id: number; trigger_scene: string }>;
  result: EventCardResult | null;
  analyzed: boolean;
  pending_confirm: boolean;
  created_at: string;
}

export function listEventCards(params?: {
  limit?: number;
  offset?: number;
}): Promise<{ cards: EventCardData[]; total: number }> {
  return apiRequest<{ cards: EventCardData[]; total: number }>('/event-cards', { query: params });
}

export function createEventCard(payload: {
  content: string;
  linked_loop_ids?: number[];
  result?: EventCardResult;
}): Promise<{
  card: EventCardData;
  auto_linked: boolean;
  pending_confirm: boolean;
  created_logs: unknown[];
}> {
  return apiRequest<{
    card: EventCardData;
    auto_linked: boolean;
    pending_confirm: boolean;
    created_logs: unknown[];
  }>('/event-cards', { method: 'POST', body: payload });
}

/** 手动触发 AI 扫描（会耗时，前端要有 loading 态） */
export function analyzeEventCards(): Promise<{
  scanned: number;
  cards_analyzed: number;
  pending_confirm: number;
  candidates: Array<{ id: number; type: 'weakness' | 'advantage'; content: string }>;
}> {
  return apiRequest<{
    scanned: number;
    cards_analyzed: number;
    pending_confirm: number;
    candidates: Array<{ id: number; type: 'weakness' | 'advantage'; content: string }>;
  }>('/event-cards/analyze', { method: 'POST' });
}

/* ------------------------------------------------- 原则 → 关联回环用的小工具 */

export interface LoopOption {
  id: number;
  weaknessId: number;
  weaknessName: string;
  status: LoopStatus;
  triggerScene: string;
}

/**
 * 取「所有可关联的回环」。
 * 契约里没有全局的回环列表接口，只能先拉弱点（三个活跃区）再逐个取详情。
 * 因此加一层 30 秒缓存，且只在用户真的打开「关联回环」时才调用。
 */
const LOOP_CACHE_TTL = 30_000;
let loopCache: { at: number; loops: LoopOption[] } | null = null;

export async function listAllLoops(force = false): Promise<LoopOption[]> {
  if (!force && loopCache && Date.now() - loopCache.at < LOOP_CACHE_TTL) {
    return loopCache.loops;
  }

  const statuses: WeaknessStatus[] = ['observing', 'improving', 'ai_candidate'];
  const groups = await apiRequest<WeaknessGroupsData>('/weaknesses', {
    query: { status_filter: statuses },
  });

  const cards = [
    ...(groups.groups.improving ?? []),
    ...(groups.groups.observing ?? []),
    ...(groups.groups.ai_candidate ?? []),
  ].slice(0, 20);

  const details = await Promise.all(
    cards.map((card) =>
      apiRequest<WeaknessDetailData>(`/weaknesses/${card.id}`).catch(() => null),
    ),
  );

  const loops: LoopOption[] = [];
  for (const detail of details) {
    if (!detail) continue;
    for (const loop of detail.loops) {
      loops.push({
        id: loop.id,
        weaknessId: detail.weakness.id,
        weaknessName: detail.weakness.name,
        status: loop.status,
        triggerScene: loop.trigger_scene,
      });
    }
  }

  loopCache = { at: Date.now(), loops };
  return loops;
}

/* -------------------------------------------------------------- 展示映射 */

export const PRINCIPLE_SOURCE_LABELS: Record<PrincipleSourceType, string> = {
  loop_rate: '回环撑住率达标',
  debate_conclusion: '辩论房结论',
  manual: '手动新建',
  ai_alternative: 'AI 替代动作',
};

export const PRINCIPLE_CONFIDENCE_LABELS: Record<PrincipleConfidence, string> = {
  high: '高',
  medium: '中',
  low: '低',
};

/**
 * 归档条目的状态说明。
 *
 * 优势的 `archived` 目前只能由定时任务产生（待确认超 30 天）；
 * 用户在界面上点「归档」走的是 `remove`，所以那边看到的是「已移除」——
 * 两者都在「已归档」折叠段里，也都能恢复。
 */
export const ADVANTAGE_ARCHIVED_LABELS: Record<'archived' | 'removed', string> = {
  archived: '超期归档',
  removed: '已移除',
};

export const PRINCIPLE_ARCHIVED_LABELS: Record<'archived' | 'ignored', string> = {
  archived: '已归档',
  ignored: '已忽略',
};

export const EVENT_RESULT_LABELS: Record<EventCardResult, string> = {
  hold: '撑住',
  break: '破功',
  not_triggered: '未触发',
  unsure: '不确定',
};

/** 事件卡结果的语义色，与回环日志保持一致 */
export const EVENT_RESULT_CLASS: Record<EventCardResult, string> = {
  hold: 'text-success',
  break: 'text-danger',
  not_triggered: 'text-tertiary',
  unsure: 'text-tertiary',
};

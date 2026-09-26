/**
 * 弱点 / 回环 / 演练日志 / 垃圾桶的数据访问层。
 *
 * 为什么不直接用 `@/api/client.ts` 里的 `weaknessApi`：
 *   1. 契约（docs/API.md 第 4/9 章）与后端实现里，**列表接口的查询参数名是
 *      `status_filter`**（`weaknessApi.list` 传的是 `status`，会被服务端忽略，
 *      于是拿不到 `archived` 分组）；优势库 / 原则库同理。
 *   2. 多个接口的响应是**包了一层**的：`{ weakness, loops, suggest_downgrade }`、
 *      `{ loop }`、`{ logs, hold_rate_30d }`…… 而 `types.ts` 里按扁平结构声明，
 *      直接读字段会静默拿到 undefined。
 *
 * 本次不允许改动 `client.ts` / `types.ts`，所以这里复用 `client.ts` 导出的
 * `apiRequest`（同一套 `credentials:'include'`、FastAPI `detail` 解析、401 跳登录、
 * 网络错误兜底），只把上面两处类型补齐。**没有新增任何 fetch 逻辑**。
 */

import { apiRequest } from '@/api/client';
import type {
  LoopLogResult,
  LoopLogSource,
  LoopStatus,
  WeaknessDomain,
  WeaknessSource,
  WeaknessStatus,
} from '@/api/types';

/* ------------------------------------------------------------------ 类型 */

/** 弱点卡（后端 weakness_out：比 types.ts 的 WeaknessCard 多 drill_count 等字段） */
export interface WeaknessCardData {
  id: number;
  name: string;
  description: string;
  domains: WeaknessDomain[];
  status: WeaknessStatus;
  confidence: number;
  source: WeaknessSource;
  source_id: number | null;
  /** 近 30 天触发次数（撑住 + 破功） */
  trigger_count_30d: number;
  hold_count_30d: number;
  hold_rate_30d: number;
  /** 预案数（回环数） */
  plan_count: number;
  /** 累计演练次数（全时段） */
  drill_count: number;
  days_since_created: number;
  created_at: string;
  archived_at: string | null;
  delete_after: string | null;
  /** 仅垃圾桶 / archived 分组才有 */
  days_until_delete?: number | null;
  /** 仅 GET /api/archive 才有 */
  expires_in_days?: number | null;
  restorable?: boolean;
}

export interface LinkedAdvantageData {
  id: number;
  name: string;
}

export interface LinkedPrincipleData {
  id: number;
  content: string;
}

export interface LoopData {
  id: number;
  weakness_id: number;
  weakness_name: string;
  trigger_scene: string;
  body_signal: string;
  action_plan: string;
  status: LoopStatus;
  linked_advantages: LinkedAdvantageData[];
  linked_principles: LinkedPrincipleData[];
  trigger_count_30d: number;
  hold_count_30d: number;
  hold_rate_30d: number;
  created_at: string;
  updated_at: string;
}

export interface LoopLogData {
  id: number;
  loop_id: number;
  weakness_id: number;
  date: string | null;
  result: LoopLogResult;
  note: string;
  source: LoopLogSource;
  source_id: number | null;
  created_at: string;
}

export interface WeaknessGroupsData {
  groups: Record<WeaknessStatus, WeaknessCardData[]>;
  total: number;
}

export interface WeaknessDetailData {
  weakness: WeaknessCardData;
  loops: LoopData[];
  /** 撑住率达标，提示用户确认降级（不自动执行） */
  suggest_downgrade: boolean;
  /** 长期 0 触发且没有回环 → 提示降档为观察存档 */
  suggest_archive: boolean;
}

export interface WeaknessCreatePayload {
  name: string;
  description: string;
  domains: WeaknessDomain[];
  confidence?: number;
}

export interface WeaknessUpdatePayload {
  name?: string;
  description?: string;
  domains?: WeaknessDomain[];
  confidence?: number;
  /** archived 只能走归档接口，服务端会拒绝 */
  status?: Exclude<WeaknessStatus, 'archived'>;
}

/** 表单入口请求体 */
export interface LoopFormPayload {
  mode: 'form';
  trigger_scene: string;
  body_signal: string;
  action_plan: string;
  activate: boolean;
  linked_advantage_ids?: number[];
  linked_principle_ids?: number[];
}

/** 对话式入口请求体：每一步都要把之前收集到的内容带上来（服务端无状态） */
export interface LoopDialogPayload {
  mode: 'dialog';
  step: 'scene' | 'signal' | 'plan';
  content: string;
  trigger_scene?: string;
  body_signal?: string;
}

export type LoopCreatePayload = LoopFormPayload | LoopDialogPayload;

/**
 * 新建回环的响应。
 *   form  → { loop }
 *   对话  → { step:'signal'|'plan', question, trigger_scene, body_signal? }
 *           { step:'confirm', loop, confirm_question }（API.md 只写了 loop + confirm_question）
 * 这里合成一个宽松结构，判别交给调用方（见 LoopDialog 的状态机）。
 */
export interface LoopCreateResponse {
  step?: string;
  question?: string;
  trigger_scene?: string;
  body_signal?: string;
  loop?: LoopData;
  confirm_question?: string;
}

export interface LoopUpdatePayload {
  trigger_scene?: string;
  body_signal?: string;
  action_plan?: string;
  status?: LoopStatus;
  linked_advantage_ids?: number[];
  linked_principle_ids?: number[];
}

export interface LoopLogCreateResponse {
  log: LoopLogData;
  hold_rate_30d: number;
  trigger_count_30d: number;
  loop_status: LoopStatus;
  /** 撑住率 ≥ 80% 且触发 ≥ 5：仅提示，绝不自动降级 */
  suggest_downgrade?: boolean;
  reason?: string;
  hint?: string;
  /** result=break 时 AI 给的替代动作 */
  alternative_action?: string;
  needs_revision?: boolean;
}

export interface LoopLogListData {
  logs: LoopLogData[];
  hold_rate_30d: number;
  trigger_count_30d: number;
  hold_count_30d: number;
}

export interface ArchiveData {
  weaknesses: WeaknessCardData[];
  advantages: Array<{ id: number; name: string; status: string }>;
  principles: Array<{ id: number; content: string; status: string }>;
  rules?: Record<string, unknown>;
}

/* ------------------------------------------------------------------ 接口 */

/** 弱点墙四区。status_filter 逗号分隔，服务端按状态分组返回。 */
export function listWeaknesses(statuses: WeaknessStatus[]): Promise<WeaknessGroupsData> {
  return apiRequest<WeaknessGroupsData>('/weaknesses', {
    query: { status_filter: statuses },
  });
}

export function getWeakness(id: number): Promise<WeaknessDetailData> {
  return apiRequest<WeaknessDetailData>(`/weaknesses/${id}`);
}

export function createWeakness(
  payload: WeaknessCreatePayload,
): Promise<{ weakness: WeaknessCardData }> {
  return apiRequest<{ weakness: WeaknessCardData }>('/weaknesses', {
    method: 'POST',
    body: payload,
  });
}

export function updateWeakness(
  id: number,
  payload: WeaknessUpdatePayload,
): Promise<{ weakness: WeaknessCardData }> {
  return apiRequest<{ weakness: WeaknessCardData }>(`/weaknesses/${id}`, {
    method: 'PATCH',
    body: payload,
  });
}

/** 移入暂存（60 天倒计时） */
export function archiveWeakness(id: number): Promise<{ weakness: WeaknessCardData; note?: string }> {
  return apiRequest<{ weakness: WeaknessCardData; note?: string }>(`/weaknesses/${id}/archive`, {
    method: 'POST',
  });
}

/** 从暂存恢复为 observing，触发计数保留 */
export function restoreWeakness(id: number): Promise<{ weakness: WeaknessCardData }> {
  return apiRequest<{ weakness: WeaknessCardData }>(`/weaknesses/${id}/restore`, { method: 'POST' });
}

export function createLoop(
  weaknessId: number,
  payload: LoopCreatePayload,
): Promise<LoopCreateResponse> {
  return apiRequest<LoopCreateResponse>(`/weaknesses/${weaknessId}/loops`, {
    method: 'POST',
    body: payload,
  });
}

export function updateLoop(loopId: number, payload: LoopUpdatePayload): Promise<{ loop: LoopData }> {
  return apiRequest<{ loop: LoopData }>(`/loops/${loopId}`, { method: 'PATCH', body: payload });
}

export function addLoopLog(
  loopId: number,
  payload: { result: LoopLogResult; note?: string; source?: LoopLogSource; date?: string },
): Promise<LoopLogCreateResponse> {
  return apiRequest<LoopLogCreateResponse>(`/loops/${loopId}/logs`, {
    method: 'POST',
    body: { source: 'manual', ...payload },
  });
}

export function listLoopLogs(loopId: number): Promise<LoopLogListData> {
  return apiRequest<LoopLogListData>(`/loops/${loopId}/logs`);
}

/** 垃圾桶：弱点含 expires_in_days */
export function getArchive(): Promise<ArchiveData> {
  return apiRequest<ArchiveData>('/archive');
}

/* -------------------------------------------------------------- 展示映射 */

export const DOMAIN_LABELS: Record<WeaknessDomain, string> = {
  work: '工作',
  relationship: '关系',
  emotion: '情绪',
  decision: '决策',
  expression: '表达',
  health: '健康',
  other: '其他',
};

/** 与方案 3.2 的字段顺序一致 */
export const DOMAIN_ORDER: WeaknessDomain[] = [
  'work',
  'relationship',
  'emotion',
  'decision',
  'expression',
  'health',
  'other',
];

export const WEAKNESS_STATUS_LABELS: Record<WeaknessStatus, string> = {
  ai_candidate: 'AI 观察候选',
  observing: '观察中',
  improving: '改善中',
  archived: '暂存',
};

export const LOOP_STATUS_LABELS: Record<LoopStatus, string> = {
  draft: '草稿',
  active: '启用中',
  needs_revision: '待修订',
  paused: '已暂停',
  archived: '已归档',
};

export const RESULT_LABELS: Record<LoopLogResult, string> = {
  hold: '撑住',
  break: '破功',
  not_triggered: '未触发',
};

export const SOURCE_LABELS: Record<WeaknessSource, string> = {
  ai: 'AI 观察',
  user: '我自建',
};

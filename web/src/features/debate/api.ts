/**
 * 辩论房 · API 适配层
 *
 * 为什么这里自己包一层，而不是直接用 `@/api/client` 的 `debateApi`
 * （那两个文件由同事维护，本次交付不改；下面是逐条理由，也是在报告里要提的契约差异）：
 *
 *   1. `debateApi.list(status)` 发的是 `?status=`，而后端 `GET /api/debates` 读的查询参数是
 *      `status_filter`（逗号分隔多值，如 `active,paused`）。契约第 3 章的表里写的是 `?status=`，
 *      与实现不一致 —— 本模块按**后端实现**发 `status_filter`。
 *   2. `debateApi.get(id)` 的返回类型标注是 `DebateRoom`，但接口实际返回
 *      `{ room, messages, review? }` 信封（见 app/api/debates.py 的 get_debate）。
 *      照标注用会直接拿到 undefined，所以这里定义 `DebateRoomDetail` 并走 `apiRequest`。
 *   3. `pause` / `resume` / `review/dismiss-observations` 三个接口 client.ts 里没有，
 *      但后端已实现（`app/api/debates.py`）且本模块要用。
 *   4. `POST /api/debates/{id}/invite` 契约没写返回结构，后端实际返回
 *      `{ invite_token, link, participant_count, max_participants }`。
 *   5. `POST /api/debates/{id}/abandon-round` 契约说 `message` 是「AI 回应」，
 *      实现返回的是本次写入的**用户侧**「（这轮我放弃）」消息（附带 is_last_round）。
 *
 * 这些收口到 `client.ts` / `types.ts` 更合适，本文件只是临时适配层。
 * 请求仍然走 client.ts 的 `apiRequest`，因此 Cookie、401 跳转、错误文案解析的行为完全一致。
 */

import { apiRequest, debateApi } from '@/api/client';
import type {
  DebateCreatePayload,
  DebateCreateResponse,
  DebateFinishResponse,
  DebateListResponse,
  DebateMessage,
  DebateRoom,
  DebateSendMessageResponse,
  DebateSourceType,
  DebateStatus,
  EventCardResult,
  LoopStatus,
  ReviewCard,
} from '@/api/types';

/* ------------------------------------------------------------------ 常量 */

/**
 * 每轮发言字数上限（契约 3 章 + app/config.py DEBATE_MESSAGE_MAX_CHARS 默认值）。
 * 后端按 Python `len()` 计数（Unicode 码点），所以前端计数也要按码点，
 * 用 `countChars()` 而不是 `String.length`，否则一个 emoji 会被算成两个字。
 */
export const DEBATE_MESSAGE_MAX_CHARS = 300;

/** 辩论房人数上限（含发起人），契约 3.1 多人与 app/config.py DEBATE_MAX_PARTICIPANTS */
export const DEBATE_MAX_PARTICIPANTS = 4;

/** 按 Unicode 码点计数，和后端 `len(content)` 对齐 */
export function countChars(text: string): number {
  return Array.from(text).length;
}

/* ------------------------------------------------------------ 本地类型 */

/** `GET /api/debates/{id}` 的真实返回：房间 + 消息（发起人还带 review） */
export interface DebateRoomDetail {
  room: DebateRoom;
  messages: DebateMessage[];
  review?: ReviewCardFull | null;
}

/** 复盘卡片 + 「本轮观察是否已关闭」（序列化层 review_out 有，契约核心对象没写全） */
export interface ReviewCardFull extends ReviewCard {
  observations_dismissed?: boolean;
}

/** `POST /api/debates/{id}/invite` 的真实返回 */
export interface DebateInviteResult {
  /**
   * 字段名是 `invite_token` 而不是 `token`。
   * 响应里另有含义完全不同的认证 token（`/api/auth/login` 的返回值），
   * 两者同名会造成误用，后端已统一改名为 `invite_token`（见 docs/API.md 13.2）。
   */
  invite_token: string;
  link: string;
  participant_count: number;
  max_participants: number;
  /**
   * 带 `friend_ids` 邀请时，**真正发出邀请**的好友（方案 6.9）。
   * 不带 friend_ids 时后端不返回这两个字段，所以是可选的。
   */
  invited?: DebateInvitedFriend[];
  /** 被跳过的：已经是成员 / 已有待接受的邀请 / 本轮名额已满 */
  skipped?: DebateSkippedFriend[];
}

export interface DebateInvitedFriend {
  user_id: number;
  invitation_id: number;
}

/** `reason` 是机器可读的短标识（如 `already_invited`），前端负责翻译成人话 */
export interface DebateSkippedFriend {
  user_id: number;
  reason: string;
}

/** `POST /api/debates/{id}/abandon-round` 的真实返回 */
export interface DebateAbandonRoundResult {
  round: number;
  /** 本次写入的「（这轮我放弃）」用户消息 */
  message: DebateMessage;
  is_last_round?: boolean;
}

/** `POST /api/debates/{id}/pause|resume` 的返回 */
export interface DebateStatusResult {
  status: DebateStatus;
}

/** `POST /api/debates/{id}/review/dismiss-observations` 的返回 */
export interface DebateDismissResult {
  ok: boolean;
  dismissed: number;
}

/* -------------------------------------------------------------- 接口 */

/**
 * 列表。`statusFilter` 用逗号分隔多值，例如 `'active,paused'`、`'finished'`。
 * 走 `apiRequest` 而不是 `debateApi.list`：见文件头第 1 条。
 */
export function listDebates(statusFilter: string): Promise<DebateListResponse> {
  return apiRequest<DebateListResponse>('/debates', { query: { status_filter: statusFilter } });
}

/** 详情（房间 + 消息 + 可选复盘）。见文件头第 2 条。 */
export function getDebateRoom(id: number): Promise<DebateRoomDetail> {
  return apiRequest<DebateRoomDetail>(`/debates/${id}`);
}

/** 新建辩论（client.ts 的签名与后端一致，直接复用） */
export function createDebate(payload: DebateCreatePayload): Promise<DebateCreateResponse> {
  return debateApi.create(payload);
}

/** 用户发言（client.ts 的签名与后端一致，直接复用） */
export function sendDebateMessage(
  id: number,
  content: string,
): Promise<DebateSendMessageResponse> {
  return debateApi.sendMessage(id, content);
}

/** 这轮我放弃 */
export function abandonDebateRound(id: number): Promise<DebateAbandonRoundResult> {
  return apiRequest<DebateAbandonRoundResult>(`/debates/${id}/abandon-round`, { method: 'POST' });
}

/** 结束并生成复盘卡片 */
export function finishDebate(id: number): Promise<DebateFinishResponse> {
  return debateApi.finish(id);
}

/** 暂停（数据完全保留，回来后 resume） */
export function pauseDebate(id: number): Promise<DebateStatusResult> {
  return apiRequest<DebateStatusResult>(`/debates/${id}/pause`, { method: 'POST' });
}

/** 继续 */
export function resumeDebate(id: number): Promise<DebateStatusResult> {
  return apiRequest<DebateStatusResult>(`/debates/${id}/resume`, { method: 'POST' });
}

/** 关闭本轮观察：关闭后不产生弱点/优势数据（方案 3.1） */
export function dismissDebateObservations(id: number): Promise<DebateDismissResult> {
  return apiRequest<DebateDismissResult>(`/debates/${id}/review/dismiss-observations`, {
    method: 'POST',
  });
}

/** 生成邀请链接 */
/**
 * 邀请（POST /api/debates/{id}/invite）。
 *
 * `friendIds` 为空时行为与从前**完全一致** —— 只生成链接（后端做了兼容）。
 * 传了好友就额外给他们各发一条**待接受**的邀请：好友在自己那边点接受才进房间，
 * 不会被直接拉进私密房间。这是刻意的不对称：
 * 「我邀请你」和「你已经在我的房间里」是两件强度完全不同的事。
 */
export function inviteToDebate(id: number, friendIds: number[] = []): Promise<DebateInviteResult> {
  return apiRequest<DebateInviteResult>(`/debates/${id}/invite`, {
    method: 'POST',
    body: { friend_ids: friendIds },
  });
}

/**
 * SSE 地址。EventSource 同源自动带 Cookie，不能改 fetch。
 * `afterSeq` 用于断线续传（契约 10 章）；后端的 stream 端点目前忽略该参数，
 * 由服务端自己找最后一条用户消息并做幂等保护，传了不会有副作用。
 */
export function debateStreamUrl(id: number, afterSeq?: number): string {
  return debateApi.streamUrl(id, afterSeq);
}

/* -------------------------------------------------------------- 预约提醒 */

/**
 * 预约辩论提醒（方案 3.9：产品里唯一的主动触达通道）。
 * 后端：app/api/debates.py 的 `GET/POST/DELETE /api/debates/{id}/reminder`
 * + app/services/push.py 的 REMINDER_PRESETS。
 *
 * `client.ts` 里没有这三个方法，本模块继续用 `apiRequest` 补齐。
 */

export interface DebateReminder {
  id: number;
  room_id: number;
  /** ISO 8601 UTC */
  remind_at: string;
  /** 服务端按本地时区格式化好的 "MM-DD HH:mm"，直接展示，前端不再自己换算 */
  remind_at_local: string;
  /** pending / sent / failed / cancelled */
  status: string;
  note: string;
}

export interface DebateReminderResult {
  reminder: DebateReminder;
  /** 该账号当前登记的推送设备数 */
  device_count: number;
  /**
   * false = 约是约上了，但一台设备都没登记，到点**收不到**。
   * 前端必须据此明确提示，不能让用户以为约好了。
   */
  will_notify: boolean;
}

/** 进入房间时读当前预约（没有则为 null） */
export function getDebateReminder(id: number): Promise<{ reminder: DebateReminder | null }> {
  return apiRequest<{ reminder: DebateReminder | null }>(`/debates/${id}/reminder`);
}

/** 用预设时间预约提醒；preset 取值来自 `GET /api/push/config` 的 presets */
export function setDebateReminder(
  id: number,
  preset: string,
  note = '',
): Promise<DebateReminderResult> {
  return apiRequest<DebateReminderResult>(`/debates/${id}/reminder`, {
    method: 'POST',
    body: { preset, note },
  });
}

/** 取消预约 */
export function cancelDebateReminder(id: number): Promise<{ ok: boolean; cancelled: boolean }> {
  return apiRequest<{ ok: boolean; cancelled: boolean }>(`/debates/${id}/reminder`, {
    method: 'DELETE',
  });
}

/* ------------------------------------------- 辩题来源 P1 回环 / P2 事件卡 */

/**
 * 起辩来源。回环 → 后端用它的触发场景 / 身体信号 / 预案拼场景（P1）；
 * 事件卡 → 用卡面内容当场景（P2）。两者都不需要用户再输入任何东西。
 */
export type DebateSourceRef =
  | { kind: 'loop'; loopId: number }
  | { kind: 'event_card'; cardId: number };

/**
 * `POST /api/debates` 的来源写法。
 *
 * 为什么不直接用 `client.ts` 的 `debateApi.create(...)`：
 *   1. `types.ts` 的 `DebateCreatePayload` 里 `stance` 是必填、且**没有 `weakness_id`**
 *      （`types.ts` 本次不允许改）。从回环起辩时后端会自己由 `loop_id` 推出
 *      `weakness_id`（app/api/debates.py 的 `_resolve_source`），这里只把
 *      `weakness_id` 按后端契约补进类型，仍然走同一个 `apiRequest`。
 *   2. 一键起辩时用户不输入立场：`stance` 传空串，后端在 topic 为空时会用
 *      AI 生成的立场兜底（`stance = stance or generated_stance`）。
 */
export interface DebateSourcePayload {
  topic?: string;
  stance?: string;
  scene?: string;
  source_type?: DebateSourceType;
  source_id?: number | null;
  loop_id?: number | null;
  /** types.ts 的 DebateCreatePayload 缺这个字段，按后端契约补上 */
  weakness_id?: number | null;
}

/** 发起辩论（来源版）。响应仍是 `{ room, first_message }`。 */
export function createDebateFromSource(
  payload: DebateSourcePayload,
): Promise<DebateCreateResponse> {
  return apiRequest<DebateCreateResponse>('/debates', {
    method: 'POST',
    body: { stance: '', ...payload },
  });
}

/** 把来源标识翻译成请求体：只有这里知道每种来源该发哪些字段 */
export function payloadFromSource(source: DebateSourceRef): DebateSourcePayload {
  return source.kind === 'loop'
    ? // 只给 loop_id：source_type 显式写成 weakness，后端据此把这场辩记成
      // 「围绕弱点练的」，同时由 loop_id 带出 weakness_id 与完整回环上下文。
      // 注意不要顺手把 loop_id 塞进 source_id——后端会拿 source_id 去查弱点卡。
      { source_type: 'weakness', loop_id: source.loopId }
    : { source_type: 'event_card', source_id: source.cardId };
}

/**
 * 「正在练的回环」（P1 的候选列表）。
 *
 * `GET /api/loops` 的 status 支持逗号分隔多值（app/api/weaknesses.py 的 list_loops
 * 里 `status` 与 `status_filter` 都接受）。只取 active / needs_revision：
 * 草稿还没成形、已暂停的不属于「正在练」，列出来只会让选择变难。
 */
export interface DebateLoopOption {
  id: number;
  weakness_id: number;
  weakness_name: string;
  trigger_scene: string;
  action_plan: string;
  status: LoopStatus;
  /** null = 还没有触发记录（不是 0%），列表里显示 `--` */
  hold_rate_30d: number | null;
}

export function listDebateLoopOptions(): Promise<{ loops: DebateLoopOption[]; total: number }> {
  return apiRequest<{ loops: DebateLoopOption[]; total: number }>('/loops', {
    query: { status: 'active,needs_revision' },
  });
}

/** 「就一件刚发生的事辩」的候选列表（P2）。默认最近 10 条，够选，不用翻历史。 */
export interface DebateEventCardOption {
  id: number;
  content: string;
  result: EventCardResult | null;
  created_at: string;
}

export function listDebateEventCards(
  limit = 10,
): Promise<{ cards: DebateEventCardOption[]; total: number }> {
  return apiRequest<{ cards: DebateEventCardOption[]; total: number }>('/event-cards', {
    query: { limit },
  });
}


/* ---------------------------------------------------- 辩题来源 P3（建议辩题） */

/**
 * 方案 3.1 的 P3：连续几天没主动出题时，AI 根据弱点库生成一个辩题。
 *
 * 注意**这不是推送** —— 方案 3.9 规定默认不推送，唯一例外是用户主动预约的
 * 辩论提醒。它只是辩论页上的一个建议，用户打开才看得到。
 */
export interface DebateSuggestion {
  topic: string;
  stance: string;
  /** ok | recent_debate | no_weakness | generation_failed */
  reason: string;
  based_on?: { weakness_id: number; weakness_name: string };
  cached?: boolean;
}

export async function getDebateSuggestion(): Promise<DebateSuggestion> {
  const data = await apiRequest<{ suggestion: DebateSuggestion }>('/debates/suggestion');
  return data.suggestion;
}

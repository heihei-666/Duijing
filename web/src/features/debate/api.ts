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
  DebateStatus,
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
export function inviteToDebate(id: number): Promise<DebateInviteResult> {
  return apiRequest<DebateInviteResult>(`/debates/${id}/invite`, { method: 'POST' });
}

/**
 * SSE 地址。EventSource 同源自动带 Cookie，不能改 fetch。
 * `afterSeq` 用于断线续传（契约 10 章）；后端的 stream 端点目前忽略该参数，
 * 由服务端自己找最后一条用户消息并做幂等保护，传了不会有副作用。
 */
export function debateStreamUrl(id: number, afterSeq?: number): string {
  return debateApi.streamUrl(id, afterSeq);
}

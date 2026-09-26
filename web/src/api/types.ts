/**
 * 对镜 · API 类型定义
 *
 * 唯一依据：docs/API.md（v1.0）+ 后端实现（app/api/*.py、app/services/serializers.py）。
 * 字段名、枚举值一律照抄英文原值，**不要**在这里翻译成中文，展示层再做映射。
 *
 * 标注 [契约未定义] 的地方表示 API.md 没写死响应结构，
 * 这里是前端的合理假设，后端联调时需要对齐。
 *
 * ⚠️ 响应信封（envelope）约定 —— 读之前请先看这段：
 * 后端绝大多数接口**不是**返回裸对象，而是包一层信封闭包，例如
 *   GET  /api/auth/me            → { user }
 *   GET  /api/debates/{id}       → { room, messages, review? }
 *   POST /api/weaknesses         → { weakness }
 *   PATCH /api/loops/{id}        → { loop }
 *   POST /api/advantages/{id}/confirm → { advantage }
 *   POST /api/observations/{id}/ignore → { ok }
 * 因此 `client.ts` 里每个方法的泛型参数必须写**信封类型**（本文件里以
 * *Response / *MutationResponse 命名），写裸对象类型（User、Loop、Principle…）
 * 会让 `res.xxx` 在编译期通过、运行时静默拿到 undefined。
 * 具体映射以后端实现为准，逐条核对过见各类型的注释。
 */

/* ------------------------------------------------------- 通用响应信封 */

/**
 * 「只表示成功」的响应，后端统一返回 `{ "ok": true }`。
 * 用在 logout / 忽略 / 归档这类没有实体返回的写操作上。
 */
export interface OkResponse {
  ok: boolean;
}

/* ------------------------------------------------------------------ 枚举 */

export type WeaknessStatus = 'ai_candidate' | 'observing' | 'improving' | 'archived';
export type WeaknessDomain =
  | 'work'
  | 'relationship'
  | 'emotion'
  | 'decision'
  | 'expression'
  | 'health'
  | 'other';
export type WeaknessSource = 'ai' | 'user';

export type LoopStatus = 'draft' | 'active' | 'needs_revision' | 'paused' | 'archived';

export type LoopLogResult = 'hold' | 'break' | 'not_triggered';
export type LoopLogSource = 'debate' | 'event_card' | 'manual';

export type AdvantageStatus = 'pending' | 'confirmed' | 'archived';

export type PrincipleStatus = 'candidate' | 'active' | 'archived';
export type PrincipleConfidence = 'high' | 'medium' | 'low';
export type PrincipleSourceType =
  | 'loop_rate'
  | 'debate_conclusion'
  | 'manual'
  | 'ai_alternative';

export type EventCardResult = 'hold' | 'break' | 'not_triggered' | 'unsure';

export type ObservationType = 'weakness' | 'advantage';
export type ObservationStatus = 'pending' | 'accepted' | 'ignored' | 'expired';

export type DebateStatus = 'active' | 'paused' | 'finished' | 'abandoned';
export type DebateSourceType = 'manual' | 'weakness' | 'event_card' | 'ai';
export type DebateMessageRole = 'ai' | 'user' | 'system';

/** POST /api/daily-state 的 mood 取值 */
export type Mood = 'great' | 'good' | 'calm' | 'low' | 'bad';

/* ------------------------------------------------------------ 核心对象 */

export interface User {
  id: number;
  username: string;
  nickname: string;
  created_at: string;
}

export interface WeaknessCard {
  id: number;
  name: string;
  description: string;
  domains: WeaknessDomain[];
  status: WeaknessStatus;
  confidence: number;
  source: WeaknessSource;
  source_id: number | null;
  trigger_count_30d: number;
  hold_count_30d: number;
  hold_rate_30d: number;
  loop_count: number;
  plan_count: number;
  days_since_created: number;
  created_at: string;
  archived_at: string | null;
  delete_after: string | null;
}

/** 回环里引用的优势 / 原则（精简形态） */
export interface LinkedAdvantage {
  id: number;
  name: string;
}

export interface LinkedPrinciple {
  id: number;
  content: string;
}

export interface Loop {
  id: number;
  weakness_id: number;
  weakness_name: string;
  trigger_scene: string;
  body_signal: string;
  action_plan: string;
  status: LoopStatus;
  linked_advantages: LinkedAdvantage[];
  linked_principles: LinkedPrinciple[];
  trigger_count_30d: number;
  hold_count_30d: number;
  hold_rate_30d: number;
  created_at: string;
  updated_at: string;
}

export interface LoopLog {
  id: number;
  loop_id: number;
  weakness_id: number;
  date: string;
  result: LoopLogResult;
  note: string | null;
  source: LoopLogSource;
  source_id: number | null;
  created_at: string;
}

/** 事件卡里关联的回环（精简形态） */
export interface LinkedLoop {
  id: number;
  trigger_scene: string;
}

export interface EventCard {
  id: number;
  content: string;
  linked_loops: LinkedLoop[];
  result: EventCardResult | null;
  analyzed: boolean;
  pending_confirm: boolean;
  created_at: string;
}

export interface Advantage {
  id: number;
  name: string;
  source: WeaknessSource;
  source_id: number | null;
  verified: boolean;
  status: AdvantageStatus;
  created_at: string;
  archived_at: string | null;
}

export interface Principle {
  id: number;
  content: string;
  source_type: PrincipleSourceType;
  source_id: number | null;
  status: PrincipleStatus;
  confidence: PrincipleConfidence;
  pinned: boolean;
  linked_loop_ids: number[];
  linked_loops: LinkedLoop[];
  created_at: string;
  updated_at: string;
}

export interface Observation {
  id: number;
  type: ObservationType;
  content: string;
  source_type: string;
  source_id: number | null;
  status: ObservationStatus;
  first_seen_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface DebateRoom {
  id: number;
  topic: string;
  stance: string;
  status: DebateStatus;
  max_rounds: number;
  current_round: number;
  source_type: DebateSourceType;
  source_id: number | null;
  is_owner: boolean;
  participant_count: number;
  loop_id: number | null;
  weakness_id: number | null;
  created_at: string;
  finished_at: string | null;
}

export interface DebateMessage {
  id: number;
  room_id: number;
  role: DebateMessageRole;
  user_id: number | null;
  nickname: string | null;
  content: string;
  round: number;
  seq: number;
  created_at: string;
}

export interface ReviewBlock {
  title: string;
  content: string;
}

export interface ReviewObservationRef {
  id: number;
  type: ObservationType;
  content: string;
}

/** 复盘卡片 */
export interface ReviewCard {
  room_id: number;
  good: ReviewBlock;
  notice: ReviewBlock;
  next_time: ReviewBlock;
  observations: ReviewObservationRef[];
  alternative_action: string;
  generated_at: string;
}

/* ------------------------------------------------------- 认证 / 邀请码 */

export interface LoginPayload {
  username: string;
  password: string;
}

export interface RegisterPayload {
  username: string;
  password: string;
  nickname: string;
  invite_code: string;
}

/** POST /api/auth/login → `{ user, token }` */
export interface AuthResponse {
  user: User;
  token: string;
}

/**
 * POST /api/auth/register → `{ user, token, is_first_user, invite_code }`
 * 比登录多两个字段：首个注册用户会成为管理员，并在这里拿到自己的邀请码。
 */
export interface RegisterResponse {
  user: User;
  token: string;
  is_first_user: boolean;
  invite_code: string;
}

/** GET /api/auth/me → `{ user }`（不是裸 User） */
export interface AuthMeResponse {
  user: User;
}

/** GET /api/auth/invite → `{ code, link, used_count }` */
export interface InviteInfo {
  code: string;
  link: string;
  used_count: number;
}

/**
 * POST /api/auth/invite/rotate → `{ code }`
 * 重置只回新码；`link` / `used_count` 需要重新调 `authApi.invite()` 才能拿到。
 */
export interface InviteRotateResponse {
  code: string;
}

/* ------------------------------------------------------------ 状态栏 */

export interface TodayLoop {
  loop_id: number;
  title: string;
  weakness_id: number;
  hold_rate_30d: number;
  trigger_count_30d: number;
}

export interface StatusBarObservation {
  id: number;
  type: ObservationType;
  content: string;
  created_at: string;
}

/** GET /api/status-bar */
export interface StatusBar {
  /** 本地日期 YYYY-MM-DD，由服务端判定 */
  date: string;
  /** 中文星期，如「周六」 */
  weekday: string;
  /** null 表示未填，前端不显示 */
  energy: number | null;
  /** null 表示未填 */
  mood: Mood | null;
  streak_days: number;
  /** 最多 2 条，按 hold_rate_30d 升序 */
  today_loops: TodayLoop[];
  /** AI 观察候选，最多 1 条 */
  observations: StatusBarObservation[];
}

/** POST /api/daily-state 请求：两项均可选，可只传一个 */
export interface DailyStatePayload {
  energy?: number;
  mood?: Mood;
}

/** POST /api/daily-state 响应 */
export interface DailyState {
  date: string;
  energy: number | null;
  mood: Mood | null;
}

/* ------------------------------------------------------------ 辩论房 */

export interface DebateCreatePayload {
  /** 可空：传 source_* 时由 AI 生成 */
  topic?: string;
  stance: string;
  source_type: DebateSourceType;
  /** weakness_id 或 event_card_id */
  source_id?: number | null;
  /** 关联回环时，AI 会制造触发场景（不告知用户） */
  loop_id?: number | null;
}

/** POST /api/debates → `{ room, first_message }` */
export interface DebateCreateResponse {
  room: DebateRoom;
  first_message: DebateMessage;
}

/**
 * GET /api/debates/{id} → `{ room, messages, review? }`
 * `review` 只对发起人返回（方案 3.1：观察与复盘不对被邀请者开放），
 * 且只有已生成复盘卡片时才存在，所以是可选字段。
 */
export interface DebateDetailResponse {
  room: DebateRoom;
  messages: DebateMessage[];
  review?: ReviewCard;
}

/** POST /api/debates/join/{invite_token} → `{ room }` */
export interface DebateJoinResponse {
  room: DebateRoom;
}

export interface DebateSendMessageResponse {
  message: DebateMessage;
  round: number;
  is_last_round: boolean;
}

export interface DebateFinishResponse {
  review: ReviewCard;
}

/** POST /api/debates/{id}/abandon-round → `{ round, message, is_last_round }` */
export interface DebateAbandonRoundResponse {
  round: number;
  /** 本次写入的「（这轮我放弃）」用户侧消息，不是 AI 回复 */
  message: DebateMessage;
  is_last_round: boolean;
}

/** [契约未定义] GET /api/debates 的外层结构 */
export interface DebateListResponse {
  rooms: DebateRoom[];
  total?: number;
}

/**
 * POST /api/debates/{id}/invite → `{ invite_token, link, participant_count, max_participants }`
 * 字段名用 `invite_token`，与认证用的 token 概念区分（见 app/api/debates.py）。
 */
export interface DebateInviteResponse {
  invite_token: string;
  link: string;
  participant_count: number;
  max_participants: number;
}

/* --------------------------------------------------- 弱点 / 回环 / 日志 */

/** GET /api/weaknesses 按状态分组返回 */
export interface WeaknessGroupsResponse {
  groups: {
    ai_candidate: WeaknessCard[];
    observing: WeaknessCard[];
    improving: WeaknessCard[];
    archived: WeaknessCard[];
  };
  total: number;
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
  status?: WeaknessStatus;
}

/**
 * 弱点写操作的信封：POST / PATCH / restore 都返回 `{ weakness }`。
 * 注意不是裸 `WeaknessCard`。
 */
export interface WeaknessMutationResponse {
  weakness: WeaknessCard;
}

/** POST /api/weaknesses/{id}/archive → `{ weakness, note }` */
export interface WeaknessArchiveResponse {
  weakness: WeaknessCard;
  /** 中文提示，如「已移入暂存，60 天后自动删除」 */
  note: string;
}

/** GET /api/weaknesses/{id}：详情（含回环列表） [回环字段名契约未明写] */
export interface WeaknessDetail extends WeaknessCard {
  loops: Loop[];
}

/** 回环 · 表单入口 */
export interface LoopFormPayload {
  mode: 'form';
  trigger_scene: string;
  body_signal: string;
  action_plan: string;
  activate: boolean;
  linked_advantage_ids?: number[];
  linked_principle_ids?: number[];
}

/** 回环 · 对话式入口（三步：scene → signal → plan） */
export interface LoopDialogPayload {
  mode: 'dialog';
  step: 'scene' | 'signal' | 'plan';
  content: string;
}

export type LoopCreatePayload = LoopFormPayload | LoopDialogPayload;

/** 表单入口 → 直接返回回环 */
export interface LoopFormResponse {
  loop: Loop;
}

/** 对话式前两步 → 回问 */
export interface LoopDialogQuestionResponse {
  step: 'signal' | 'plan';
  question: string;
}

/** 对话式第三步 → 草稿 + 确认问句 */
export interface LoopDialogDraftResponse {
  loop: Loop;
  confirm_question: string;
}

export type LoopCreateResponse =
  | LoopFormResponse
  | LoopDialogQuestionResponse
  | LoopDialogDraftResponse;

/** PATCH /api/loops/{id} → `{ loop }`（不是裸 Loop） */
export interface LoopMutationResponse {
  loop: Loop;
}

export interface LoopUpdatePayload {
  trigger_scene?: string;
  body_signal?: string;
  action_plan?: string;
  status?: LoopStatus;
  linked_advantage_ids?: number[];
  linked_principle_ids?: number[];
}

export interface LoopLogPayload {
  result: LoopLogResult;
  note?: string | null;
  source: LoopLogSource;
  source_id?: number | null;
  /** YYYY-MM-DD，不传由服务端按「今天」处理 */
  date?: string;
}

export interface LoopLogCreateResponse {
  log: LoopLog;
  /** hold_rate ≥ 80% 且 trigger_count ≥ 5 时为 true（提示用户确认，不自动降级） */
  suggest_downgrade?: boolean;
  /** result=break 时返回的替代动作 */
  alternative_action?: string;
}

/** [契约未定义] GET /api/loops/{id}/logs 的外层结构 */
export interface LoopLogListResponse {
  logs: LoopLog[];
}

/* ------------------------------------------------------------ 事件卡 */

export interface EventCardCreatePayload {
  content: string;
  /** 传了 linked_loop_ids + result 才立即写 loop_log */
  linked_loop_ids?: number[];
  result?: EventCardResult;
}

export interface EventCardCreateResponse {
  card: EventCard;
  auto_linked: boolean;
  pending_confirm: boolean;
  created_logs: LoopLog[];
}

export interface EventCardAnalyzeResponse {
  scanned: number;
  candidates: Array<{ id: number; type: ObservationType; content: string }>;
  updated_cards: number;
}

/** [契约未定义] GET /api/event-cards 的外层结构 */
export interface EventCardListResponse {
  cards: EventCard[];
  total?: number;
}

/* ------------------------------------------------------- 优势 / 原则 */

/** [契约未定义] GET /api/advantages 的外层结构（后端还返回 total / pending_count） */
export interface AdvantageListResponse {
  advantages: Advantage[];
}

/** POST /api/advantages/{id}/confirm | /restore → `{ advantage }` */
export interface AdvantageMutationResponse {
  advantage: Advantage;
}

/**
 * POST /api/advantages/{id}/remove → `{ ok, note }`
 * 移除不物理删除，只留痕（status=removed），所以没有 advantage 返回。
 */
export interface AdvantageRemoveResponse {
  ok: boolean;
  note: string;
}

/** [契约未定义] GET /api/principles 的外层结构（后端还返回 total / candidate_count） */
export interface PrincipleListResponse {
  principles: Principle[];
}

/** POST /principles、PATCH /principles/{id}、confirm / restore → `{ principle }` */
export interface PrincipleMutationResponse {
  principle: Principle;
}

export interface PrincipleCreatePayload {
  content: string;
  source_type?: PrincipleSourceType;
  source_id?: number | null;
  confidence?: PrincipleConfidence;
  linked_loop_ids?: number[];
}

/** PATCH /api/principles/{id} */
export interface PrincipleUpdatePayload {
  content?: string;
  pinned?: boolean;
  linked_loop_ids?: number[];
  status?: PrincipleStatus;
}

/* ------------------------------------------------------------ AI 观察 */

/** [契约未定义] GET /api/observations 的外层结构 */
export interface ObservationListResponse {
  observations: Observation[];
}

/**
 * POST /api/observations/{id}/accept 返回的落库结果。
 * `kind` 与 `ObservationType` 取值完全一致（'weakness' | 'advantage'），已核对后端实现。
 */
export interface ObservationAcceptResponse {
  created: { kind: ObservationType; id: number };
}

/* ------------------------------------------------------------ 归档 */

/** [契约未定义] GET /api/archive 的外层结构 */
export interface ArchiveResponse {
  weaknesses: WeaknessCard[];
  advantages: Advantage[];
  principles: Principle[];
}

/** POST /api/archive/purge → `{ deleted }`：物理删除的弱点条数 */
export interface ArchivePurgeResponse {
  deleted: number;
}

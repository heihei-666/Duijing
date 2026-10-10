/**
 * 对镜 · API 客户端
 *
 * 约定（docs/API.md）：
 *   - 基础路径 `/api`，内容类型 application/json; charset=utf-8
 *   - 认证走 httpOnly Cookie（dj_token），因此所有请求 credentials: 'include'
 *   - 错误统一为 FastAPI 结构 { "detail": "中文说明" }，这里解析后抛出中文 Error
 *   - 401 自动跳转 /login（登录/注册/me 除外，避免误跳和死循环）
 *
 * ⚠️ 响应信封：后端绝大多数接口**不是**返回裸对象，而是包一层信封，例如
 * `GET /api/auth/me → { user }`、`POST /api/weaknesses → { weakness }`、
 * `PATCH /api/loops/{id} → { loop }`。所以下面每个 `request<T>()` 的泛型参数
 * 必须写 `./types` 里的信封类型（*Response / *MutationResponse），**不要**写
 * `User` / `WeaknessCard` / `Loop` 这类裸对象类型 —— 那样 `res.xxx` 能通过编译，
 * 运行时却静默拿到 undefined。逐条映射见 types.ts 顶部说明。
 *
 * 列表筛选参数：后端 `status` 与 `status_filter` **两个名字都接受**
 * （app/api/debates.py、weaknesses.py、advantages.py、principles.py、observations.py
 * 都做了兼容：`status or status_filter`）。API.md 第 3 章写的是 `status`，
 * 早期实现用的是 `status_filter`，为避免任何一侧静默失效，后端保留了双名兼容。
 * 本文件统一发 `status`。注意两者同时传时**以 `status` 优先**。
 *
 * 开发环境由 vite dev server 代理到 http://127.0.0.1:3000，
 * 生产环境由 Nginx 同源反代，所以这里永远用相对路径。
 */

import type {
  AuthMeResponse,
  AuthResponse,
  DailyState,
  DailyStatePayload,
  DebateAbandonRoundResponse,
  DebateCreatePayload,
  DebateCreateResponse,
  DebateDetailResponse,
  DebateFinishResponse,
  DebateInviteResponse,
  DebateJoinResponse,
  DebateListResponse,
  DebateSendMessageResponse,
  DebateStatus,
  EventCardAnalyzeResponse,
  EventCardCreatePayload,
  EventCardCreateResponse,
  EventCardListResponse,
  InviteInfo,
  InviteRotateResponse,
  LoginPayload,
  ObservationAcceptResponse,
  ObservationListResponse,
  ObservationStatus,
  OkResponse,
  RegisterPayload,
  RegisterResponse,
  StatusBar,
} from './types';

// Bearer 兜底令牌：httpOnly Cookie 靠不住的环境（微信内置浏览器）用。
// 详见 token.ts 顶部的证据与取舍说明。
import { clearBearerToken, getBearerToken, setBearerToken } from './token';

const API_PREFIX = '/api';

/** 已登录时不应该再看到的路由，用于避免 401 后的重复跳转 */
const AUTH_ROUTES = ['/login', '/register', '/join'];

/** 后端没给 detail 时的兜底文案 */
const STATUS_MESSAGES: Record<number, string> = {
  400: '请求内容有误，请检查后重试',
  401: '登录状态已失效，请重新登录',
  403: '没有权限执行该操作',
  404: '内容不存在或已被删除',
  409: '内容冲突，请刷新后重试',
  422: '提交的内容格式不正确',
  429: '操作太频繁了，请稍后再试',
  500: '服务器出错了，请稍后再试',
  502: '服务暂时不可用，请稍后再试',
  503: '服务暂时不可用，请稍后再试',
};

export class ApiError extends Error {
  /** HTTP 状态码；0 表示请求根本没发出去（断网 / 被拦截） */
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

type QueryValue = string | number | boolean | null | undefined | Array<string | number>;

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 会被 JSON.stringify 的请求体 */
  body?: unknown;
  /** 查询参数；null / undefined 自动忽略，数组按逗号拼接 */
  query?: Record<string, QueryValue>;
  /** 401 时是否自动跳转登录页，默认 true */
  redirectOn401?: boolean;
  signal?: AbortSignal;
}

function buildQuery(query?: Record<string, QueryValue>): string {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, raw] of Object.entries(query)) {
    if (raw === null || raw === undefined) continue;
    const value = Array.isArray(raw) ? raw.join(',') : String(raw);
    if (value === '') continue;
    params.append(key, value);
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : '';
}

/** 401 → 跳登录页，并把当前地址带上，登录后可以回到原处 */
function redirectToLogin(): void {
  if (typeof window === 'undefined') return;
  const { pathname, search, hash } = window.location;
  if (AUTH_ROUTES.some((route) => pathname.startsWith(route))) return;
  const from = encodeURIComponent(`${pathname}${search}${hash}`);
  window.location.assign(`/login?from=${from}`);
}

/** 把响应体解析成一句中文错误说明 */
async function resolveErrorMessage(response: Response): Promise<string> {
  let detail: unknown;
  try {
    const data: unknown = await response.json();
    if (data && typeof data === 'object' && 'detail' in data) {
      detail = (data as { detail: unknown }).detail;
    }
  } catch {
    // 响应不是 JSON，走状态码兜底
  }

  if (typeof detail === 'string' && detail.trim() !== '') return detail;

  // FastAPI 422 的 detail 是数组：[{ loc, msg, type }, ...]
  if (Array.isArray(detail)) {
    const messages = detail
      .map((item) =>
        item && typeof item === 'object' && 'msg' in item
          ? String((item as { msg: unknown }).msg)
          : '',
      )
      .filter((item) => item !== '');
    if (messages.length > 0) return messages.join('；');
  }

  return STATUS_MESSAGES[response.status] ?? `请求失败（${response.status}）`;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, query, redirectOn401 = true, signal } = options;

  // 有兜底令牌就带上。**后端里 Bearer 优先于 Cookie**
  // （见 app/deps.py::extract_token），所以这个令牌必须与 Cookie 同生共死：
  // 一旦留下陈旧的 token，它会盖住仍然有效的 Cookie，把「能用」变成「不能用」。
  const bearer = getBearerToken();

  let response: Response;
  try {
    response = await fetch(`${API_PREFIX}${path}${buildQuery(query)}`, {
      method,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  } catch (error) {
    // 主动取消不算错误，原样上抛交给调用方
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('网络连接失败，请检查网络后重试', 0);
  }

  if (response.status === 401) {
    const message = await resolveErrorMessage(response);
    if (redirectOn401) {
      // 这条请求本该是已登录状态，却拿到 401 —— 会话已经失效，
      // 顺手清掉兜底令牌，免得它继续盖住（可能仍然有效的）Cookie。
      clearBearerToken();
      redirectToLogin();
    }
    throw new ApiError(message, 401);
  }

  if (!response.ok) {
    throw new ApiError(await resolveErrorMessage(response), response.status);
  }

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  if (text === '') return undefined as T;
  return JSON.parse(text) as T;
}

/* ------------------------------------------------------------------ 认证 */

export const authApi = {
  /** 注册 → `{ user, token, is_first_user, invite_code }` */
  register: (payload: RegisterPayload) =>
    request<RegisterResponse>('/auth/register', {
      method: 'POST',
      body: payload,
      redirectOn401: false,
    }).then((res) => {
      // 存下兜底令牌：微信内置浏览器不保存 Cookie，只能靠它维持会话
      setBearerToken(res.token);
      return res;
    }),

  /** 登录 → `{ user, token }` */
  login: (payload: LoginPayload) =>
    request<AuthResponse>('/auth/login', {
      method: 'POST',
      body: payload,
      redirectOn401: false,
    }).then((res) => {
      setBearerToken(res.token);
      return res;
    }),

  logout: () =>
    request<OkResponse>('/auth/logout', { method: 'POST', redirectOn401: false }).finally(() => {
      // 无论服务端是否成功，本地令牌都要清掉。
      // 留着它就是留一个会盖住 Cookie 的陈旧凭证。
      clearBearerToken();
    }),

  /** 会话恢复 → `{ user }`；未登录时返回 401，属于正常情况，不跳转 */
  me: () => request<AuthMeResponse>('/auth/me', { redirectOn401: false }),

  invite: () => request<InviteInfo>('/auth/invite'),

  /** 重置邀请码 → `{ code }`（只有新码，link / used_count 需重新调 invite()） */
  rotateInvite: () => request<InviteRotateResponse>('/auth/invite/rotate', { method: 'POST' }),
};

/* ---------------------------------------------------------------- 状态栏 */

export const statusApi = {
  getStatusBar: () => request<StatusBar>('/status-bar'),

  saveDailyState: (payload: DailyStatePayload) =>
    request<DailyState>('/daily-state', { method: 'POST', body: payload }),
};

/* ---------------------------------------------------------------- 辩论房 */

export const debateApi = {
  list: (status?: Extract<DebateStatus, 'active' | 'finished'>) =>
    request<DebateListResponse>('/debates', { query: { status } }),

  create: (payload: DebateCreatePayload) =>
    request<DebateCreateResponse>('/debates', { method: 'POST', body: payload }),

  get: (id: number) => request<DebateDetailResponse>(`/debates/${id}`),

  sendMessage: (id: number, content: string) =>
    request<DebateSendMessageResponse>(`/debates/${id}/messages`, {
      method: 'POST',
      body: { content },
    }),

  finish: (id: number) =>
    request<DebateFinishResponse>(`/debates/${id}/finish`, { method: 'POST' }),

  abandonRound: (id: number) =>
    request<DebateAbandonRoundResponse>(`/debates/${id}/abandon-round`, { method: 'POST' }),

  invite: (id: number) =>
    request<DebateInviteResponse>(`/debates/${id}/invite`, { method: 'POST' }),

  join: (inviteToken: string) =>
    request<DebateJoinResponse>(`/debates/join/${inviteToken}`, { method: 'POST' }),

  /**
   * SSE 地址（EventSource 同源自动带 Cookie，不能改 fetch）。
   *
   * `afterSeq` 会作为 `?after_seq=` 带上，但后端 stream 端点**忽略**这个参数：
   * 它自己取最后一条用户消息，再靠「这一轮已经生成过 AI 回复就不再生成」的
   * 幂等保护避免重复推送（见 app/api/debates.py 的 stream_reply）。
   * 所以续传时传不传都一样，传了无害。
   * 用法：new EventSource(debateApi.streamUrl(roomId, lastSeq))
   */
  streamUrl: (id: number, afterSeq?: number) =>
    `${API_PREFIX}/debates/${id}/stream${buildQuery({ after_seq: afterSeq })}`,
};
/* ---------------------------------------------------------------- 事件卡 */

export const eventCardApi = {
  list: (params?: { limit?: number; offset?: number }) =>
    request<EventCardListResponse>('/event-cards', { query: params }),

  create: (payload: EventCardCreatePayload) =>
    request<EventCardCreateResponse>('/event-cards', { method: 'POST', body: payload }),

  /** 手动触发 AI 扫描最近事件卡 */
  analyze: () =>
    request<EventCardAnalyzeResponse>('/event-cards/analyze', { method: 'POST' }),
};
/* --------------------------------------------------------------- AI 观察 */

export const observationApi = {
  /**
   * 默认只看 pending。
   * 注意：服务端会在返回时把 first_seen_at 置为当前时间（仅首次），
   * 24 小时后未处理自动 expired。
   */
  list: (status: ObservationStatus = 'pending') =>
    request<ObservationListResponse>('/observations', { query: { status } }),

  accept: (id: number) =>
    request<ObservationAcceptResponse>(`/observations/${id}/accept`, { method: 'POST' }),

  /** 忽略 → `{ ok }` */
  ignore: (id: number) => request<OkResponse>(`/observations/${id}/ignore`, { method: 'POST' }),
};
export { request as apiRequest };

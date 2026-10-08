/**
 * 好友模块的数据访问层（方案 3.10）。
 *
 * `client.ts` 里没有好友相关方法，用 `apiRequest` 补齐——同一套 credentials /
 * 错误解析 / 401 处理，不另起一套。
 *
 * ⚠️ 类型上的一个刻意安排：`FriendItem` 里 `streak_days` / `practiced_today`
 * 是 `number | null` / `boolean | null`，**不是** `number` / `boolean`。
 * 后端在对方未开启分享时返回的是 `null` 而不是 0 / false——
 * 因为 0 会被显示成「他连着 0 天」，那是在编造事实。类型跟着一起可空，
 * 前端就必须显式处理「看不到」这个状态，而不能靠默认值蒙混过去。
 */

import { apiRequest } from '@/api/client';

export interface FriendItem {
  user_id: number;
  username: string;
  nickname: string;
  /** 对方是否开启了对好友分享今日进度 */
  sharing: boolean;
  /** 未开启分享时为 null */
  streak_days: number | null;
  /** 未开启分享时为 null */
  practiced_today: boolean | null;
}

export interface FriendRequestItem {
  id: number;
  user_id: number;
  username: string;
  nickname: string;
  created_at: string;
}

export interface UserBrief {
  user_id: number;
  username: string;
  nickname: string;
}

export interface SearchResult {
  found: boolean;
  already_friends?: boolean;
  user?: UserBrief;
}

export function listFriends(): Promise<{ friends: FriendItem[] }> {
  return apiRequest<{ friends: FriendItem[] }>('/friends');
}

/** 按用户名**精确**查找。后端刻意不做模糊搜索——那等于提供「浏览全站用户」的入口。 */
export function searchUser(username: string): Promise<SearchResult> {
  return apiRequest<SearchResult>('/friends/search', { query: { username } });
}

export function listRequests(): Promise<{
  incoming: FriendRequestItem[];
  outgoing: FriendRequestItem[];
}> {
  return apiRequest<{ incoming: FriendRequestItem[]; outgoing: FriendRequestItem[] }>(
    '/friends/requests',
  );
}

export function sendRequest(username: string): Promise<{ id: number; status: string }> {
  return apiRequest<{ id: number; status: string }>('/friends/requests', {
    method: 'POST',
    body: { username },
  });
}

export function acceptRequest(id: number): Promise<{ id: number; status: string }> {
  return apiRequest<{ id: number; status: string }>(`/friends/requests/${id}/accept`, {
    method: 'POST',
  });
}

/** 拒绝是**终态**：对方不能再向你申请，除非你先删掉他（见方案 3.10 防骚扰）。 */
export function rejectRequest(id: number): Promise<{ id: number; status: string }> {
  return apiRequest<{ id: number; status: string }>(`/friends/requests/${id}/reject`, {
    method: 'POST',
  });
}

export function removeFriend(userId: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/friends/${userId}`, { method: 'DELETE' });
}

/* ---------------------------------------------------------------- 辩论邀请 */

export interface DebateInvitationItem {
  id: number;
  room_id: number;
  topic: string;
  stance: string;
  inviter: UserBrief;
  participant_count: number;
  max_participants: number;
  created_at: string;
}

export function listDebateInvitations(): Promise<{ invitations: DebateInvitationItem[] }> {
  return apiRequest<{ invitations: DebateInvitationItem[] }>('/debates/invitations');
}

export function acceptDebateInvitation(id: number): Promise<{ room: { id: number } }> {
  return apiRequest<{ room: { id: number } }>(`/debates/invitations/${id}/accept`, {
    method: 'POST',
  });
}

export function declineDebateInvitation(id: number): Promise<{ ok: boolean }> {
  return apiRequest<{ ok: boolean }>(`/debates/invitations/${id}/decline`, { method: 'POST' });
}

/** 邀请好友进辩论房。**是待接受的邀请，不是直接把人拉进去**（方案 3.10）。 */
export function inviteFriendsToDebate(
  roomId: number,
  friendIds: number[],
): Promise<{ invited: Array<{ user_id: number; invitation_id: number }>; skipped: Array<{ user_id: number; reason: string }> }> {
  return apiRequest(`/debates/${roomId}/invite`, {
    method: 'POST',
    body: { friend_ids: friendIds },
  });
}

/**
 * 分享开关。
 *
 * 后端在 `PATCH /api/account/profile` 上（不在好友路由里）——它属于用户偏好，
 * 和「通知开关」是同一类东西。
 */
export function setShareProgress(enabled: boolean): Promise<{ profile: { share_progress_with_friends: boolean } }> {
  return apiRequest<{ profile: { share_progress_with_friends: boolean } }>('/account/profile', {
    method: 'PATCH',
    body: { share_progress_with_friends: enabled },
  });
}

export function getProfile(): Promise<{
  profile: { share_progress_with_friends: boolean; level: string };
}> {
  return apiRequest('/account/profile');
}

/** 跳过原因 → 中文。后端返回机器可读的 reason，展示层在这里翻译。 */
export const SKIP_REASON_LABELS: Record<string, string> = {
  self: '不能邀请自己',
  not_friend: '不是好友',
  already_invited: '已经邀请过了',
  room_full: '房间已满',
};

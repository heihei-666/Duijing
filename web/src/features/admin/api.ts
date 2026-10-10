import { apiRequest } from '@/api/client';

/**
 * 管理接口（`/api/admin/*`，受 `require_admin` 保护）。
 *
 * 目前只有用户管理。存在的理由很具体：**这个项目没有邮件也没有短信**，
 * 用户忘了密码就没人能帮 —— 在此之前只能由开发者手工改库。
 */

export interface AdminUser {
  id: number;
  username: string;
  nickname: string;
  is_admin: boolean;
  created_at: string;
  /** 非 null 表示本人提交过注销申请，管理员需要人工确认 */
  deletion_requested_at: string | null;
}

export interface ResetPasswordResult {
  user_id: number;
  username: string;
  /** 一次性临时密码，**只在这一刻返回，之后再也拿不到** */
  temp_password: string;
  /** 被重置的是不是管理员自己 */
  is_self: boolean;
  note: string;
}

export function listUsers(): Promise<{ users: AdminUser[] }> {
  return apiRequest<{ users: AdminUser[] }>('/admin/users');
}

/**
 * 为**别人**重置密码，返回一次性临时密码。
 *
 * 不校验旧密码 —— 管理员本来就看不到别人的密码（库里只有 bcrypt 哈希），
 * 「重置」是唯一可行的语义。改自己的密码走 `PATCH /api/account/password`，
 * 那条**必须验当前密码**。
 */
export function resetUserPassword(userId: number): Promise<ResetPasswordResult> {
  return apiRequest<ResetPasswordResult>(`/admin/users/${userId}/reset-password`, {
    method: 'POST',
  });
}

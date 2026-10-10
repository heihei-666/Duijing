import type { User } from '@/api/types';

/**
 * 角色判定 —— **全项目唯一一处**。
 *
 * 【为什么要有这个文件】
 *
 * 现在只有两种人：普通用户、管理员。前端各处直接读 `user.is_admin` 就够了。
 * 但角色一旦变多（比如以后加「督导」「只读观察者」，或让管理员分出层级），
 * `is_admin` 这种布尔值会立刻不够用 —— 而那时**每一处 `user.is_admin`
 * 都要找出来改**，漏一处就是「某个角色看到了不该看的入口」。
 *
 * 所以现在就把判定收成一个函数：**将来加角色只改这里**。
 * 代价是这一个文件，收益是将来那次改动只改一个地方。
 *
 * 【为什么返回数组而不是布尔值】
 *
 * 因为「一个人可能有多个身份」是常态（管理员同时也是普通用户）。
 * 判布尔值的话，`is_admin` 和 `is_user` 会互相打架；判集合就没有这个问题。
 */

/** 基础角色：每个登录用户都有。分组排序、通用功能都以它为准。 */
export const BASE_ROLE = 'user';

/** 管理员。与后端 `User.is_admin` 对应（第一个注册的用户自动获得）。 */
export const ADMIN_ROLE = 'admin';

/**
 * 当前用户拥有的角色集合。
 *
 * **加新角色时改这里**：例如以后有 `moderator`，
 * 判断条件加在这一个函数里，所有调用方自动生效。
 */
export function rolesOf(user: User | null): string[] {
  if (!user) return [];
  // 管理员**同时**是普通用户 —— 这不是重复，是因为很多通用功能
  // 只声明 `roles: ['user']`，管理员也必须能看到它们。
  return user.is_admin ? [BASE_ROLE, ADMIN_ROLE] : [BASE_ROLE];
}

/** 这个用户能不能看到声明了 `roles` 的分组。空数组 = 不限制。 */
export function canSee(roles: string[], user: User | null): boolean {
  if (roles.length === 0) return true;
  const mine = rolesOf(user);
  return roles.some((role) => mine.includes(role));
}

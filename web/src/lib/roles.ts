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

/** 基础角色：每个**正式**登录用户都有。分组排序、通用功能都以它为准。 */
export const BASE_ROLE = 'user';

/** 管理员。与后端 `User.is_admin` 对应（第一个注册的用户自动获得）。 */
export const ADMIN_ROLE = 'admin';

/**
 * 访客。与后端 `User.is_guest` 对应（`POST /api/auth/guest` 创建的临时账号）。
 *
 * 访客是一个**真实的登录用户**，只是还没认领。所以它拿的是 `guest` 这一个
 * 角色而**不是** `user` —— 「能访问哪些页面」这件事上，访客和正式账号
 * 是互斥的两类，不该用「有 user 再加个 guest 标记」来表达。
 * 以后如果访客要能用某个通用功能，把这个角色加进那个功能的 `roles` 即可。
 */
export const GUEST_ROLE = 'guest';

/**
 * 当前用户拥有的角色集合。
 *
 * **加新角色时改这里**：例如以后有 `moderator`，
 * 判断条件加在这一个函数里，所有调用方自动生效。
 */
export function rolesOf(user: User | null): string[] {
  if (!user) return [];
  // 访客与正式账号互斥：访客没有任何「正式用户」的能力
  if (user.is_guest) return [GUEST_ROLE];
  // 管理员**同时**是普通用户 —— 这不是重复，是因为很多通用功能
  // 只声明 `roles: ['user']`，管理员也必须能看到它们。
  return user.is_admin ? [BASE_ROLE, ADMIN_ROLE] : [BASE_ROLE];
}

/**
 * 是不是访客账号。
 *
 * 全项目判定访客**只走这里** —— 页面里散着读 `user.is_guest` 的话，
 * 将来「访客」的定义一变（比如加了「已体验但未认领」和「已认领但未验证」），
 * 就得把所有读取点找出来改，漏一处就是某类访客看到了不该看的入口。
 *
 * 用 `=== true` 而不是直接取真值：`User.is_guest` 由服务端保证一定有值，
 * 但如果某个旧接口漏了这个字段，`=== true` 会让它按**正式账号**处理 ——
 * 也就是「多看到一些入口」而不是「被挡在门外」。宁可多给，不可误拦。
 */
export function isGuest(user: User | null): boolean {
  return user?.is_guest === true;
}

/** 这个用户能不能看到声明了 `roles` 的分组。空数组 = 不限制。 */
export function canSee(roles: string[], user: User | null): boolean {
  if (roles.length === 0) return true;
  const mine = rolesOf(user);
  return roles.some((role) => mine.includes(role));
}

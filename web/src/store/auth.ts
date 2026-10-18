import { create } from 'zustand';

import { authApi } from '@/api/client';
import { clearBearerToken } from '@/api/token';
import type { ClaimPayload, LoginPayload, RegisterPayload, User } from '@/api/types';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous';

/**
 * 访客是从哪个按钮进来的。
 *
 * 落地页有两个入口（「免费试用 3 分钟微辩论」/「记下一件让你不爽的事」），
 * 进去之后落在同一页 `/start`，但**内容顺序应该不一样**：
 * 从「记下一件不爽的事」进来的人，第一眼就该看到那个输入框。
 *
 * 【为什么存在 store 里，而不是 URL 的 ?mode=】
 *
 * 点完按钮后 `enterGuestMode()` 一返回，`status` 就变 authenticated，
 * `RootLayout` 会立刻把访客 `<Navigate to="/start" replace>` 过去。
 * 那次 replace 发生在 React 渲染之后，**会把任何带查询参数的跳转覆盖掉**。
 * 所以意图必须存在一个不随路由变化的地方 —— store 正好。
 *
 * 副作用是「谁负责跳转」只有一处：RootLayout。落地页只管建号和记意图，
 * 不自己 navigate，也就没有两条跳转互相打架的可能。
 */
export type GuestEntry = 'debate' | 'scene';

interface AuthState {
  /** 当前用户；未登录为 null */
  user: User | null;
  /** idle = 还没恢复会话，loading = 正在恢复 */
  status: AuthStatus;
  /** 访客是从哪个入口进来的，决定 /start 页先把哪块内容摆出来 */
  guestEntry: GuestEntry;
  /**
   * 应用启动时调 `GET /api/auth/me` 恢复会话。
   *
   * 认证有两条路，服务端按「显式优先」取值（`app/deps.py::extract_token`）：
   *   1. `Authorization: Bearer` —— 兜底，给不保存 Cookie 的浏览器用（微信内置浏览器）
   *   2. httpOnly Cookie `dj_token` —— 主路径，普通浏览器走这条
   *
   * 前端不需要知道当前走的是哪条，只需保证两者同生共死（见 `api/token.ts`）。
   */
  bootstrap: () => Promise<void>;
  /** 失败时抛出 ApiError，由页面决定怎么展示 */
  login: (payload: LoginPayload) => Promise<User>;
  register: (payload: RegisterPayload) => Promise<User>;
  logout: () => Promise<void>;
  /**
   * 进入访客模式：建一个临时账号并直接登录。
   *
   * 为什么写进 store 而不是让落地页自己调接口：
   * `user` / `status` 是全局状态，**任何一处直接调接口而不更新 store，
   * 界面就会停在「未登录」而服务端已经认为是登录态** —— 之后所有请求
   * 都带着访客身份，界面却还在显示落地页。收口在这里就不会有第二个写法。
   *
   * @param entry 从哪个按钮进来的，默认 `debate`
   */
  enterGuestMode: (entry?: GuestEntry) => Promise<User>;
  /**
   * 认领访客账号（体验完注册）。
   *
   * 成功后 `user.is_guest` 变 false，同一个 id、同一份数据 ——
   * 所以调用方不需要做任何数据刷新，界面会自动从「访客」切到「正式账号」。
   */
  claimAccount: (payload: ClaimPayload) => Promise<User>;
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  status: 'idle',
  guestEntry: 'debate',

  bootstrap: async () => {
    // 只恢复一次；React StrictMode 下 effect 会跑两遍，这里挡住第二次
    if (get().status !== 'idle') return;
    set({ status: 'loading' });
    try {
      // GET /api/auth/me 返回的是 { user } 信封，不是裸 User（与 login / register 一致）
      const { user } = await authApi.me();
      set({ user, status: 'authenticated' });
    } catch {
      // 401 是正常情况（还没登录），不当成错误。
      // 但若本地存着兜底令牌，说明它是失效的 —— 必须清掉，
      // 否则它会持续盖住可能仍然有效的 Cookie（Bearer 优先于 Cookie）。
      clearBearerToken();
      set({ user: null, status: 'anonymous' });
    }
  },

  login: async (payload) => {
    const { user } = await authApi.login(payload);
    set({ user, status: 'authenticated' });
    return user;
  },

  register: async (payload) => {
    const { user } = await authApi.register(payload);
    set({ user, status: 'authenticated' });
    return user;
  },

  logout: async () => {
    try {
      await authApi.logout();
    } finally {
      // 无论服务端是否成功，本地都要退出
      set({ user: null, status: 'anonymous' });
    }
  },

  enterGuestMode: async (entry = 'debate') => {
    const { user } = await authApi.createGuest();
    // 意图和登录态**一次 set 写完**：分两次的话中间会渲染一帧，
    // 那一帧里 /start 可能已经挂载但读到的还是上一次的入口意图。
    set({ guestEntry: entry, user, status: 'authenticated' });
    return user;
  },

  claimAccount: async (payload) => {
    const { user } = await authApi.claim(payload);
    set({ user, status: 'authenticated' });
    return user;
  },
}));

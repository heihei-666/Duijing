import { create } from 'zustand';

import { authApi } from '@/api/client';
import { clearBearerToken } from '@/api/token';
import type { LoginPayload, RegisterPayload, User } from '@/api/types';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  /** 当前用户；未登录为 null */
  user: User | null;
  /** idle = 还没恢复会话，loading = 正在恢复 */
  status: AuthStatus;
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
}

export const useAuthStore = create<AuthState>()((set, get) => ({
  user: null,
  status: 'idle',

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
}));

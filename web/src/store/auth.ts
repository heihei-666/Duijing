import { create } from 'zustand';

import { authApi } from '@/api/client';
import type { LoginPayload, RegisterPayload, User } from '@/api/types';

export type AuthStatus = 'idle' | 'loading' | 'authenticated' | 'anonymous';

interface AuthState {
  /** 当前用户；未登录为 null */
  user: User | null;
  /** idle = 还没恢复会话，loading = 正在恢复 */
  status: AuthStatus;
  /** 应用启动时调 GET /api/auth/me 恢复会话（Cookie 认证，前端不存 token） */
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
      // 401 是正常情况（还没登录），不当成错误
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

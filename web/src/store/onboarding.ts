import { create } from 'zustand';

/**
 * 新手态（onboarding）—— 全站共享「这个用户是不是还没有任何数据」。
 *
 * 【为什么需要一个 store，而不是各页面自己判断】
 *
 * 首页知道 `is_fresh_start`（服务端算好的），但**左侧导航也需要知道** ——
 * 新用户的「弱点」「资产」点进去全是空页面，那是最容易劝退的一刻。
 * 导航在 `AppShell` 里，和首页是两个组件树分支，中间没有 props 通路。
 *
 * 三个可选做法：
 *   1. 导航自己再请求一次 /api/status-bar —— 多一次请求，而且两处可能不同步
 *   2. 每个页面各自传 props 给 AppShell —— 路由结构不支持
 *   3. 一个极小的 store —— 谁先拿到谁写入，读的人只读
 * 选 3：状态只有一个布尔值，不值得为它引入 context/provider 树。
 *
 * 【为什么默认值是 `null` 而不是 `false`】
 *
 * `null` = 还不知道。**不知道的时候不要加锁** —— 宁可让用户点进一个空页面，
 * 也不要把一个其实有数据的入口锁起来。所以所有 `fresh` 判断都写 `=== true`。
 *
 * 【锁的文案是产品决定的】
 *
 * 不写「暂未开放」（像在推诿），写「记录 / 辩论后解锁你的专属画像」——
 * 它同时说了「为什么现在没有」和「怎么才能有」。
 */
interface OnboardingState {
  /** null = 还不确定；true = 全新用户（没有任何数据） */
  fresh: boolean | null;
  /** 用户点了哪个被锁的入口（用来渲染弹层）；null = 没点 */
  lockedLabel: string | null;
  setFresh: (fresh: boolean) => void;
  /** 点了一个还没解锁的 tab：拦住跳转，改成弹层说明 */
  openLock: (label: string) => void;
  closeLock: () => void;
}

export const useOnboardingStore = create<OnboardingState>()((set) => ({
  fresh: null,
  lockedLabel: null,
  setFresh: (fresh) => set({ fresh }),
  openLock: (label) => set({ lockedLabel: label }),
  closeLock: () => set({ lockedLabel: null }),
}));

/**
 * 某个 tab 现在是不是「锁着的」。
 *
 * 只有「确定是全新用户」+「这个 tab 声明了 lockForFresh」才锁。
 * 已登录但还没加载过首页的用户是 `fresh === null` → 不锁。
 */
export function isTabLocked(fresh: boolean | null, lockForFresh?: boolean): boolean {
  return fresh === true && Boolean(lockForFresh);
}

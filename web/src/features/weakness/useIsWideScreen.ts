import { useSyncExternalStore } from 'react';

/**
 * 是否宽屏（Web 端黑板）。断点与 Tailwind 的 `md` 完全对齐：768px。
 *
 * 为什么用 JS 断点而不是 `hidden md:block` 两份 DOM 都渲染：
 *   1. 两份 DOM 意味着同一条弱点在无障碍树里出现两次，长按计时器、焦点顺序也会翻倍；
 *   2. dnd-kit 的传感器会挂在隐藏的那份上，窗口一变大就可能出现两套拖拽上下文。
 *   这里窄屏时**只渲染原来的列表**，宽屏时**只渲染黑板**，
 * 移动端那条路径连一次多余的 hook 都不会多跑。
 */
const WIDE_QUERY = '(min-width: 768px)';

let cachedQuery: MediaQueryList | null = null;

function mediaQuery(): MediaQueryList {
  if (!cachedQuery) cachedQuery = window.matchMedia(WIDE_QUERY);
  return cachedQuery;
}

function subscribe(onStoreChange: () => void): () => void {
  const mql = mediaQuery();
  mql.addEventListener('change', onStoreChange);
  return () => mql.removeEventListener('change', onStoreChange);
}

function getSnapshot(): boolean {
  return mediaQuery().matches;
}

/** 首次渲染就读到真实值，不会先闪一下列表再切黑板 */
export function useIsWideScreen(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}

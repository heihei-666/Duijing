import { useCallback, useRef } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

/** 长按判定时长：移动端 480ms 手感比较稳，不会和滚动抢手势 */
const LONG_PRESS_MS = 480;
/** 手指/鼠标移动超过这个距离就认为是滑动，取消长按 */
const MOVE_TOLERANCE = 8;

interface LongPressHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUp: () => void;
  onPointerLeave: () => void;
  onPointerCancel: () => void;
  onClick: () => void;
  onContextMenu: (event: { preventDefault: () => void }) => void;
}

/**
 * 长按手势（方案 3.2「移动端：列表态 + 分区折叠，长按改状态」）。
 *
 * 关键点：长按触发后，手指抬起时浏览器仍会补一个 click，
 * 这里用 `fired` 标记把它吃掉，避免「刚打开操作面板就跳进详情页」。
 * 移动端还要屏蔽长按弹出的系统菜单（onContextMenu）。
 */
export function useLongPress(onLongPress: () => void, onClick?: () => void): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const fired = useRef(false);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      // 只响应主键 / 触摸，右键菜单不参与
      if (event.button !== 0) return;
      origin.current = { x: event.clientX, y: event.clientY };
      fired.current = false;
      clear();
      timer.current = window.setTimeout(() => {
        timer.current = null;
        fired.current = true;
        onLongPress();
      }, LONG_PRESS_MS);
    },
    [clear, onLongPress],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const start = origin.current;
      if (!start || timer.current === null) return;
      if (
        Math.abs(event.clientX - start.x) > MOVE_TOLERANCE ||
        Math.abs(event.clientY - start.y) > MOVE_TOLERANCE
      ) {
        clear();
      }
    },
    [clear],
  );

  const handleClick = useCallback(() => {
    if (fired.current) {
      fired.current = false;
      return;
    }
    onClick?.();
  }, [onClick]);

  return {
    onPointerDown: handlePointerDown,
    onPointerMove: handlePointerMove,
    onPointerUp: clear,
    onPointerLeave: clear,
    onPointerCancel: clear,
    onClick: handleClick,
    onContextMenu: (event) => event.preventDefault(),
  };
}

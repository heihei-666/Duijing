import { NavLink } from 'react-router-dom';

import { LockIcon } from '@/components/icons';
import { TABS } from '@/components/layout/tabs';
import { cn } from '@/lib/cn';
import { isTabLocked, useOnboardingStore } from '@/store/onboarding';

/**
 * 底部 4 Tab（方案 2.2）—— **只在窄屏出现**。
 *
 * 桌面端换成左侧竖向导航（`SideNav`）：把一条底部标签栏留在 1920px 的
 * 浏览器窗口底下，是「这是个手机页面」最强烈的信号，而且鼠标要先跨越
 * 整个屏幕才能点到它。
 *
 * Tab 态只用中性色的明度差（未选中 --text-tertiary / 选中 --text-primary），
 * 不引入第三种彩色。
 *
 * 【新用户的「小锁」】和 SideNav 同一套规则（见 `tabs.ts` 的 lockForFresh）：
 * 弱点和资产对新用户是空的，点进去只有挫败感，所以挂锁 + 点击弹说明。
 * 两个导航必须同时处理 —— 否则会出现「手机上锁了、电脑上没锁」的诡异不一致。
 */
export function TabBar() {
  const fresh = useOnboardingStore((s) => s.fresh);
  const openLock = useOnboardingStore((s) => s.openLock);

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-light bg-surface dj-safe-bottom lg:hidden">
      <ul className="mx-auto flex w-full max-w-2xl items-stretch">
        {TABS.map(({ to, label, Icon, end, lockForFresh }) => {
          const locked = isTabLocked(fresh, lockForFresh);
          return (
            <li key={to} className="flex-1">
              <NavLink
                to={to}
                end={end}
                onClick={(event) => {
                  if (!locked) return;
                  event.preventDefault();
                  openLock(label);
                }}
                aria-disabled={locked || undefined}
                className={({ isActive }) =>
                  cn(
                    'flex flex-col items-center gap-1 py-2.5 text-[11px] transition-colors',
                    locked ? 'text-tertiary' : isActive ? 'text-primary' : 'text-tertiary',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <span className="relative">
                      <Icon width={22} height={22} strokeWidth={isActive ? 1.8 : 1.5} />
                      {locked ? (
                        <span className="absolute -right-2.5 -top-1 rounded-full bg-surface text-tertiary">
                          <LockIcon width={12} height={12} />
                        </span>
                      ) : null}
                    </span>
                    <span>{label}</span>
                  </>
                )}
              </NavLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}



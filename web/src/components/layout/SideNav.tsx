import { NavLink } from 'react-router-dom';

import { LockIcon } from '@/components/icons';
import { TABS } from '@/components/layout/tabs';
import { cn } from '@/lib/cn';
import { isTabLocked, useOnboardingStore } from '@/store/onboarding';

/**
 * 桌面端左侧竖向导航（≥1024px）。
 *
 * 【为什么要有它】
 *
 * 原本只有底部标签栏。在 1920px 的浏览器里，内容被限死在 672px 居中、
 * 底部还挂着一条手机式标签栏 —— 用户的原话是「很明显感觉竖屏观看体验」。
 *
 * 左侧导航是桌面应用的标准形态，和 `AppShell` 放开的内容宽度是一套的：
 * 导航从「占一整行」变成「占一列」，省下的纵向空间还给内容。
 *
 * 【为什么固定定位而不是 flex 兄弟】
 *
 * 内容区可以滚动很长（辩论记录、弱点列表）。`fixed` 让导航始终可见，
 * 不用每页各自处理 sticky。代价是内容区要用 `lg:pl-56` 让位 ——
 * 这个宽度写死在 `AppShell` 里，改这里必须一起改。
 *
 * 【新用户的「小锁」】
 *
 * 弱点和资产对新用户是空的。点进去看三个空状态，比直接告诉他
 * 「还差什么」更劝退，所以这里挂锁、点击改成弹层说明（见 LockedFeatureSheet）。
 * 注意用的是**拦点击**而不是「禁用」：禁用态点了没有反馈，用户只会以为坏了。
 */
export function SideNav() {
  const fresh = useOnboardingStore((s) => s.fresh);
  const openLock = useOnboardingStore((s) => s.openLock);

  return (
    <nav className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-light bg-surface px-3 py-6 lg:flex">
      <p className="px-3 text-[15px] font-medium text-primary">对镜</p>

      <ul className="mt-6 space-y-1">
        {TABS.map(({ to, label, Icon, end, lockForFresh }) => {
          const locked = isTabLocked(fresh, lockForFresh);
          return (
            <li key={to}>
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
                    'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] transition-colors',
                    locked
                      ? 'text-disabled hover:bg-elevated'
                      : isActive
                        ? 'bg-elevated text-primary'
                        : 'text-tertiary hover:bg-elevated hover:text-secondary',
                  )
                }
              >
                {({ isActive }) => (
                  <>
                    <Icon width={20} height={20} strokeWidth={isActive ? 1.8 : 1.5} />
                    <span>{label}</span>
                    {locked ? (
                      <span className="ml-auto text-tertiary">
                        <LockIcon width={13} height={13} />
                      </span>
                    ) : null}
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


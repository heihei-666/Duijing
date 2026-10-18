import { NavLink } from 'react-router-dom';

import { GearIcon, LockIcon, MoonIcon, SunIcon } from '@/components/icons';
import { TABS } from '@/components/layout/tabs';
import { cn } from '@/lib/cn';
import { isTabLocked, useOnboardingStore } from '@/store/onboarding';
import { useThemeStore } from '@/store/theme';

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
 *
 * 【底部两个全局项（`mt-auto` 压到底）】
 *
 *   设置 —— 跳 `/assets?tab=settings`。桌面端没有底部标签栏，
 *           「设置」藏在资产页里等于找不到，所以侧栏底部给它一个固定入口。
 *   外观 —— 白天 / 黑夜切换。做成两个图标并排的开关，而不是一个「切换」按钮：
 *           单个按钮看不出当前是哪种模式，也无法直接选另一种。
 */
export function SideNav() {
  const fresh = useOnboardingStore((s) => s.fresh);
  const openLock = useOnboardingStore((s) => s.openLock);
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

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
                      ? 'text-tertiary hover:bg-elevated'
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

      {/* mt-auto 把它压到底部：上面是内容导航，下面是全局项，两类东西分开 */}
      <div className="mt-auto space-y-3">
        <NavLink
          to="/assets?tab=settings"
          className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] text-tertiary transition-colors hover:bg-elevated hover:text-secondary"
        >
          <GearIcon width={20} height={20} />
          <span>设置</span>
        </NavLink>

        <div className="px-1">
          <p className="mb-1.5 px-2 text-[11px] text-tertiary">外观</p>
          <div
            className="flex items-center gap-1 rounded-lg bg-elevated p-1"
            role="group"
            aria-label="外观模式"
          >
            {[
              { key: 'light' as const, label: '白天', Icon: SunIcon },
              { key: 'dark' as const, label: '黑夜', Icon: MoonIcon },
            ].map(({ key, label, Icon }) => {
              const active = mode === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => setMode(key)}
                  aria-pressed={active}
                  title={label}
                  className={cn(
                    'flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-[12px] transition-colors',
                    active
                      ? 'bg-surface text-primary shadow-card'
                      : 'text-tertiary hover:text-secondary',
                  )}
                >
                  <Icon width={15} height={15} />
                  <span>{label}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}

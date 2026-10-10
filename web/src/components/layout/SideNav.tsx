import { NavLink } from 'react-router-dom';

import { TABS } from '@/components/layout/tabs';
import { cn } from '@/lib/cn';

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
 */
export function SideNav() {
  return (
    <nav className="fixed inset-y-0 left-0 z-30 hidden w-56 flex-col border-r border-light bg-surface px-3 py-6 lg:flex">
      <p className="px-3 text-[15px] font-medium text-primary">对镜</p>

      <ul className="mt-6 space-y-1">
        {TABS.map(({ to, label, Icon, end }) => (
          <li key={to}>
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-3 rounded-lg px-3 py-2.5 text-[14px] transition-colors',
                  isActive
                    ? 'bg-elevated text-primary'
                    : 'text-tertiary hover:bg-elevated hover:text-secondary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon width={20} height={20} strokeWidth={isActive ? 1.8 : 1.5} />
                  <span>{label}</span>
                </>
              )}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  );
}

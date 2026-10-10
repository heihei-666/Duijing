import { NavLink } from 'react-router-dom';

import { TABS } from '@/components/layout/tabs';
import { cn } from '@/lib/cn';

/**
 * 底部 4 Tab（方案 2.2）—— **只在窄屏出现**。
 *
 * 桌面端换成左侧竖向导航（`SideNav`）：把一条底部标签栏留在 1920px 的
 * 浏览器窗口底下，是「这是个手机页面」最强烈的信号，而且鼠标要先跨越
 * 整个屏幕才能点到它。
 *
 * Tab 态只用中性色的明度差（未选中 --text-tertiary / 选中 --text-primary），
 * 不引入第三种彩色。
 */
export function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-light bg-surface dj-safe-bottom lg:hidden">
      <ul className="mx-auto flex w-full max-w-2xl items-stretch">
        {TABS.map(({ to, label, Icon, end }) => (
          <li key={to} className="flex-1">
            <NavLink
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex flex-col items-center gap-1 py-2.5 text-[11px] transition-colors',
                  isActive ? 'text-primary' : 'text-tertiary',
                )
              }
            >
              {({ isActive }) => (
                <>
                  <Icon width={22} height={22} strokeWidth={isActive ? 1.8 : 1.5} />
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

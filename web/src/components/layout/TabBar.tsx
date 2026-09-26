import { NavLink } from 'react-router-dom';

import { AssetsIcon, DebateIcon, HomeIcon, WeaknessIcon } from '@/components/icons';
import { cn } from '@/lib/cn';

/**
 * 底部 4 Tab（方案 2.2）。
 * 移动端优先，桌面端内容居中限宽 max-w-2xl。
 * Tab 态只用中性色的明度差（未选中 --text-tertiary / 选中 --text-primary），
 * 不引入第三种彩色。
 */
const TABS = [
  { to: '/', label: '首页', Icon: HomeIcon, end: true },
  { to: '/debates', label: '辩论', Icon: DebateIcon, end: false },
  { to: '/weaknesses', label: '弱点', Icon: WeaknessIcon, end: false },
  { to: '/assets', label: '资产', Icon: AssetsIcon, end: false },
] as const;

export function TabBar() {
  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-light bg-surface dj-safe-bottom">
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

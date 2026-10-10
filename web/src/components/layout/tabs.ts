import { AssetsIcon, DebateIcon, HomeIcon, WeaknessIcon } from '@/components/icons';

/**
 * 主框架的 4 个 Tab（方案 2.2）。
 *
 * **抽出来共用的理由**：移动端渲染成底部标签栏（`TabBar`），
 * 桌面端渲染成左侧竖向导航（`SideNav`）。两处各写一份的话，
 * 加一个 Tab 时必然漏改一处 —— 而「手机上能看到、电脑上找不到」
 * 这种 bug 很难在开发时被发现。
 */
export const TABS = [
  { to: '/', label: '首页', Icon: HomeIcon, end: true },
  { to: '/debates', label: '辩论', Icon: DebateIcon, end: false },
  { to: '/weaknesses', label: '弱点', Icon: WeaknessIcon, end: false },
  { to: '/assets', label: '资产', Icon: AssetsIcon, end: false },
] as const;

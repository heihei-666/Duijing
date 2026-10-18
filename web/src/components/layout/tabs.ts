import { AssetsIcon, DebateIcon, HomeIcon, WeaknessIcon } from '@/components/icons';

/**
 * 主框架的 4 个 Tab（方案 2.2）。
 *
 * **抽出来共用的理由**：移动端渲染成底部标签栏（`TabBar`），
 * 桌面端渲染成左侧竖向导航（`SideNav`）。两处各写一份的话，
 * 加一个 Tab 时必然漏改一处 —— 而「手机上能看到、电脑上找不到」
 * 这种很难在开发时被发现。
 *
 * 【lockForFresh：新用户点进去只有空页面】
 *
 * 「弱点」「资产」两页的内容**全部来自用户自己的记录**。一个刚注册、
 * 什么都还没做的人点进去，看到的是「还没有弱点」「还没有优势」「还没有原则」——
 * 三个空状态叠在一起，传递的信息是「这东西没什么用」。
 *
 * 所以新用户态下这两项挂锁：说清为什么空、怎么才能有，而不是让他点进去看空页面。
 * 「辩论」不锁 —— 它是产生数据的入口，锁住它等于把门焊死。
 */
export const TABS = [
  { to: '/', label: '首页', Icon: HomeIcon, end: true, lockForFresh: false },
  { to: '/debates', label: '辩论', Icon: DebateIcon, end: false, lockForFresh: false },
  { to: '/weaknesses', label: '弱点', Icon: WeaknessIcon, end: false, lockForFresh: true },
  { to: '/assets', label: '资产', Icon: AssetsIcon, end: false, lockForFresh: true },
] as const;

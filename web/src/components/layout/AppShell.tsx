import { Outlet, useLocation } from 'react-router-dom';

import { SideNav } from '@/components/layout/SideNav';
import { TabBar } from '@/components/layout/TabBar';
import { cn } from '@/lib/cn';

/**
 * 登录后的主框架。
 *
 * 【两套导航，按屏宽切换】
 *
 *   · 窄屏（< 1024px）—— 底部 4 Tab + 居中限宽内容
 *   · 宽屏（≥ 1024px）—— 左侧竖向导航 + 放开的内容宽度
 *
 * 之前只有前者。结果是在 1920px 的浏览器上，内容被限死在 672px 居中、
 * 底部还挂着一条手机式标签栏 —— 用户的原话是「很明显感觉竖屏观看体验」。
 *
 * 【宽屏为什么还是限宽，而不是铺满】
 *
 * 铺满 1920px 会让每行文字长到 150+ 字符，阅读时眼睛要来回扫，反而更累。
 * 所以放开到 `max-w-3xl`（768px）—— 比手机宽得多，又还在舒适阅读区间内。
 * 弱点的看板页另给 `max-w-6xl`（见下）。
 *
 * 【左侧导航的让位宽度写死在两处】
 *
 * `SideNav` 是 `fixed` + `w-56`（224px），内容区靠 `lg:pl-56` 让位。
 * 改导航宽度时必须同时改这两处 —— 这里和 SideNav 的注释里都写了。
 */
export function AppShell() {
  const { pathname } = useLocation();
  // 只匹配列表页本身；/weaknesses/:id 详情页仍是阅读型页面，保持窄版
  const isBoard = pathname === '/weaknesses';

  return (
    <div className="min-h-screen bg-base">
      <SideNav />

      {/* lg:pl-56 给固定的左侧导航让位；窄屏没有导航，不需要 */}
      <div className="lg:pl-56">
        <div
          className={cn(
            'mx-auto flex min-h-screen w-full flex-col',
            isBoard ? 'max-w-2xl lg:max-w-6xl' : 'max-w-2xl lg:max-w-3xl',
          )}
        >
          {/* pb-24 给窄屏的固定底栏留位；宽屏没有底栏，收紧到 pb-10 */}
          <main className={cn('flex-1 pb-24 pt-6 lg:pb-10 lg:pt-8', isBoard ? 'px-4 lg:px-8' : 'px-4 lg:px-8')}>
            <Outlet />
          </main>
        </div>
      </div>

      <TabBar />
    </div>
  );
}

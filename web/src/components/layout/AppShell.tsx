import { Outlet, useLocation } from 'react-router-dom';

import { TabBar } from '@/components/layout/TabBar';
import { cn } from '@/lib/cn';

/**
 * 登录后的主框架：底部 4 Tab + 居中限宽内容区。
 *
 * 限宽按路由区分：默认 `max-w-2xl`（672px），这是移动优先应用该有的宽度，
 * 阅读类页面在宽屏上铺满反而难读。
 *
 * 唯一的例外是**弱点墙**：方案 2.2 要求 Web 端做成「黑板拖拽」，
 * 三列并排 + 垃圾桶。672px 减去内边距和列间距后每列只有约 205px，
 * 一张便签要放名称、描述、角标和撑住率条，会窄到难读、也难拖。
 * 所以只给这一个页面在宽屏下放行。
 */
export function AppShell() {
  const { pathname } = useLocation();
  // 只匹配列表页本身；/weaknesses/:id 详情页仍是阅读型页面，保持窄版
  const isBoard = pathname === '/weaknesses';

  return (
    <div className="min-h-screen bg-base">
      <div
        className={cn(
          'mx-auto flex min-h-screen w-full flex-col',
          isBoard ? 'max-w-2xl lg:max-w-5xl' : 'max-w-2xl',
        )}
      >
        {/* pb-24：给固定底栏（约 60px + 安全区）留位 */}
        <main className={cn('flex-1 pb-24 pt-6', isBoard ? 'px-4 lg:px-6' : 'px-4')}>
          <Outlet />
        </main>
      </div>
      <TabBar />
    </div>
  );
}

import { Outlet } from 'react-router-dom';

import { TabBar } from '@/components/layout/TabBar';

/** 登录后的主框架：底部 4 Tab + 居中限宽内容区 */
export function AppShell() {
  return (
    <div className="min-h-screen bg-base">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col">
        {/* pb-24：给固定底栏（约 60px + 安全区）留位 */}
        <main className="flex-1 px-4 pb-24 pt-6">
          <Outlet />
        </main>
      </div>
      <TabBar />
    </div>
  );
}

import { useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';

import { BootSplash } from '@/components/common/BootSplash';
import { Button } from '@/components/common/Button';
import { GUEST_COPY } from '@/features/guest/copy';
import { ClaimSheet } from '@/features/guest/ClaimSheet';
import { isGuest } from '@/lib/roles';
import { useAuthStore } from '@/store/auth';

/**
 * 「正式账号才有的页面」守卫。
 *
 * 【它拦的是什么】
 *
 * 访客（`is_guest`）能用的只有辩论：开一场、辩完、拿复盘。
 * 弱点墙 / 资产 / 设置 / 多人邀请这些都要拦 —— 不是技术上进不去
 * （访客是一个真实用户，接口全都通），而是**产品上不该让他进去**：
 *
 *   1. 那些页面此刻全是空的。一个刚来 3 分钟的人看到「还没有弱点」
 *      「还没有优势」「还没有原则」，只会得出「这东西没什么用」。
 *   2. 它们是他**注册之后**才该看到的奖励。先看见空屋子，再被告知
 *      「注册就能解锁」，比压根没看见更没有吸引力。
 *
 * 【为什么不是静默重定向】
 *
 * 直接跳转会让人以为链接坏了或自己点错了。这里明确告诉他
 * 「这是你的私人空间」，并给出一个当场就能走完的出口（保存并注册）。
 * 用户手动敲 URL 进来时，这是他唯一能看到这句解释的地方。
 *
 * 【为什么注册成功后不会卡在这】
 *
 * 认领成功后 `user.is_guest` 变 false，zustand 触发重渲染，
 * 下一次渲染会直接走 `<Outlet />` —— 唯一的例外是弹窗还开着，
 * 那时先留着蒙层让他看见「已经保存好了」（见下面那个 if 的注释）。
 */
export function RequireFullAccount() {
  const navigate = useNavigate();
  const status = useAuthStore((state) => state.status);
  const user = useAuthStore((state) => state.user);
  const guest = isGuest(user);
  const [claimOpen, setClaimOpen] = useState(false);

  // 未登录的情况归 RequireAuth 管（它在外层），这里只兜一个启动期
  if (status === 'idle' || status === 'loading') return <BootSplash />;

  // 认领成功的**同一瞬间** guest 就变 false 了。如果这里直接放行，
  // 弹窗会被立刻卸载，用户根本看不到「已经保存好了」那一屏 ——
  // 他只会看到页面内容突然换了，不知道自己刚才做了什么。
  // 所以：弹窗开着就继续渲染蒙层，等他点「进入对镜」或关掉再放行。
  if (!guest && !claimOpen) return <Outlet />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-base px-6">
      <div className="w-full max-w-sm text-center">
        <p className="text-xs tracking-[0.2em] text-tertiary">对 镜</p>
        <h1 className="mt-5 text-[22px] font-medium leading-snug text-primary">
          {GUEST_COPY.lockTitle}
        </h1>
        <p className="mt-2.5 text-[14px] leading-relaxed text-secondary">{GUEST_COPY.lockBody}</p>

        <div className="mt-6 space-y-2.5">
          <Button fullWidth onClick={() => setClaimOpen(true)}>
            {GUEST_COPY.lockCta}
          </Button>
          <Button variant="outline" fullWidth onClick={() => navigate('/start')}>
            回到辩论
          </Button>
        </div>

        <p className="mt-4 text-[11px] leading-relaxed text-tertiary">
          {GUEST_COPY.saveRetention}
        </p>
      </div>

      <ClaimSheet open={claimOpen} onClose={() => setClaimOpen(false)} />
    </div>
  );
}

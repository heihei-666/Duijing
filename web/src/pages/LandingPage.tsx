import { useCallback, useState } from 'react';
import { Link } from 'react-router-dom';

import { Button } from '@/components/common/Button';
import { GUEST_COPY } from '@/features/guest/copy';
import { useAuthStore, type GuestEntry } from '@/store/auth';

/**
 * 落地页 —— 未登录用户访问 `/` 时看到的第一屏。
 *
 * 【为什么需要它】
 *
 * 在此之前，未登录用户访问 `duijing.xyz` 直接就是登录/注册表单。
 * 这违背了「先体验后注册」——**在用户还不知道这东西是干什么之前，
 * 就要他先交出账号密码**。市面上有一定规模的产品几乎没有这么做的。
 *
 * 【文案原则：不写「改变你的弱点」】
 *
 * 写「发现你未曾察觉的盲区」。
 * 前者是**评判**（你有问题，我来修你），后者是**发现**（有些东西你没看见）。
 * 同样是自我提升，「被评判」会让人防御，「被看见」才会让人好奇。
 * 这个产品最独特的地方是辩论房里那句「AI 全程观察但一个字都不说」——
 * 它天然就是「发现」而不是「纠正」。
 *
 * 【两个按钮都进访客模式，但落点不同】
 *
 *   主按钮「免费试用 3 分钟微辩论」→ /start，预设题点一下就能开局（零输入）
 *   副按钮「记下一件让你不爽的事」→ /start，但先摆出描述框
 *
 * 副按钮不是「另一个功能」，而是**同一个功能的另一种起点**：
 * 说不出「辩题」是很正常的事，说得出一件刚发生的窝囊事才是常态。
 * 后端 `scene` 字段就是为此存在的（AI 把它转成辩题）。
 *
 * 【为什么这里只管建号，不管跳转】
 *
 * 建号成功后 `status` 变 authenticated，`RootLayout` 会立刻把访客
 * 重定向到 `/start`。如果这里再 `navigate` 一次，两条跳转就会打架
 * （后发生的那条会覆盖前一条，把入口意图丢掉）。
 * 所以跳转只有 RootLayout 一处，这里只负责「建号 + 记下从哪个按钮进来」。
 */
export function LandingPage() {
  const enterGuestMode = useAuthStore((state) => state.enterGuestMode);

  const [entering, setEntering] = useState<GuestEntry | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleEnter = useCallback(
    async (target: GuestEntry) => {
      if (entering) return;
      setEntering(target);
      setError(null);
      try {
        // 成功的话这一页马上会被 RootLayout 换成 /start，不需要再 navigate
        await enterGuestMode(target);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : '暂时没能进入体验，请稍后再试');
        setEntering(null);
      }
    },
    [enterGuestMode, entering],
  );

  const busy = entering !== null;

  return (
    <div className="min-h-screen bg-base">
      <div className="mx-auto flex min-h-screen w-full max-w-2xl flex-col justify-center px-6 py-12 lg:max-w-3xl">
        {/* ── 主视觉 ───────────────────────────────────────── */}
        <div className="text-center">
          <p className="text-xs tracking-[0.2em] text-tertiary">对 镜</p>

          <h1 className="mt-6 text-[28px] font-medium leading-snug text-primary lg:text-[34px]">
            发现你未曾察觉的盲区
          </h1>

          <p className="mx-auto mt-4 max-w-md text-[15px] leading-relaxed text-secondary">
            和一个 AI 就一件真实的事辩一场。
            辩的过程中它一句评价都不说 —— 结束后才告诉你，你刚才是什么样子。
          </p>
        </div>

        {/* ── 体验入口 ─────────────────────────────────────── */}
        <div className="mx-auto mt-10 w-full max-w-sm space-y-3">
          <Button
            fullWidth
            size="lg"
            loading={entering === 'debate'}
            disabled={busy}
            onClick={() => void handleEnter('debate')}
          >
            {GUEST_COPY.ctaPrimary}
          </Button>

          <Button
            variant="outline"
            fullWidth
            size="lg"
            loading={entering === 'scene'}
            disabled={busy}
            onClick={() => void handleEnter('scene')}
          >
            {GUEST_COPY.ctaSecondary}
          </Button>

          {error ? (
            <p className="rounded-xl border border-danger-light bg-danger-light px-3 py-2.5 text-center text-[13px] leading-relaxed text-primary">
              {error}
            </p>
          ) : (
            <p className="pt-1 text-center text-xs leading-relaxed text-tertiary">
              {GUEST_COPY.ctaHint}
            </p>
          )}
        </div>

        {/* ── 三个特征 ─────────────────────────────────────── */}
        <div className="mx-auto mt-12 w-full max-w-md space-y-3">
          {[
            {
              title: 'AI 全程不说教',
              // 这一条原来写的是「辩论中它只当对手」。换成陪练人格之后那句话就不对了 ——
              // 它仍然是好对手，但不再把人问住。落地页是最容易被截图传播的一屏，
              // 上面写的东西必须和辩论房里真实发生的事一致。
              body: '辩论中它是陪练：会和你就事论事地辩，但不会把你问住。观察留到结束后才给。',
            },
            {
              title: '观察要你确认才算数',
              body: 'AI 提出的每一条观察都是「候选」，你认可了才进你的弱点墙。',
            },
            {
              title: '这里只有你自己',
              body: '弱点、回环、复盘都不对任何人可见。你写什么，只有你知道。',
            },
          ].map((item) => (
            <div key={item.title} className="rounded-xl bg-surface px-4 py-3">
              <p className="text-[13px] text-primary">{item.title}</p>
              <p className="mt-1 text-xs leading-relaxed text-tertiary">{item.body}</p>
            </div>
          ))}
        </div>

        {/*
          ── 老用户入口 ─────────────────────────────────────
          之前这里是两个 12px 的灰色下划线文字，藏在三张特征卡下面 ——
          **回访用户要滚 1.5 屏才找得到登录口**。而他们恰恰是最没耐心的一群人：
          已经知道自己要什么，只想快点进去。

          现在改成两个 44px 高的按钮（和主 CTA 同一套视觉语言，但用描边不用实底），
          宽度与上方两个 CTA 对齐。位置仍在底部 —— 刻意不放到主 CTA 旁边，
          因为这一页的第一眼必须留给「试一下」，不是「进去」。
        */}
        <div className="mx-auto mt-12 w-full max-w-sm">
          <p className="text-center text-[13px] text-tertiary">已有账号？直接登录，不用再体验一遍。</p>
          <div className="mt-3 flex gap-3">
            <Link
              to="/login"
              className="flex h-11 flex-1 items-center justify-center rounded-xl border border-light bg-surface text-[15px] font-medium text-primary transition-colors hover:bg-elevated active:bg-inset"
            >
              登录
            </Link>
            <Link
              to="/register"
              className="flex h-11 flex-1 items-center justify-center rounded-xl border border-light bg-surface text-[15px] font-medium text-primary transition-colors hover:bg-elevated active:bg-inset"
            >
              注册
            </Link>
          </div>
          {/*
            把「注册要邀请码」写在这里，而不是等用户辩完三分钟再告诉他。
            体验本身完全免费、不要码；只有「保存」需要。
            提前说清楚，撞到那一步时他才不会觉得是套路。
          */}
          <p className="mt-3 text-center text-[11px] leading-relaxed text-tertiary">
            注册是邀请制，需要一个邀请码；体验不需要。
          </p>
        </div>
      </div>
    </div>
  );
}

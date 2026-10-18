import { Link } from 'react-router-dom';

import { Button } from '@/components/common/Button';

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
 * 【阶段说明】
 *
 * 阶段 1（现在）：主按钮暂时导向注册页 —— 访客模式（阶段 2）还没做，
 *   点了没有别的地方可去。这是**有意的临时状态**，不是漏了。
 * 阶段 2 会把 CTA 改成「直接进入访客辩论房」。
 */
export function LandingPage() {
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
            它全程只观察、不说话 —— 结束后才告诉你，你刚才是什么样子。
          </p>
        </div>

        {/* ── 体验入口 ─────────────────────────────────────── */}
        <div className="mx-auto mt-10 w-full max-w-sm space-y-3">
          {/*
            ⚠️ 阶段 2 会把这个按钮改成「进入访客辩论房」。
            现在导向注册，是因为访客模式还不存在 —— 点了必须有地方可去。
          */}
          <Link to="/register" className="block">
            <Button fullWidth>免费试用 3 分钟微辩论</Button>
          </Link>

          <Link to="/register" className="block">
            <Button variant="outline" fullWidth>
              记下一件让你不爽的事
            </Button>
          </Link>

          <p className="pt-1 text-center text-xs leading-relaxed text-tertiary">
            不需要先注册。体验完再决定要不要保存。
          </p>
        </div>

        {/* ── 三个特征 ─────────────────────────────────────── */}
        <div className="mx-auto mt-12 w-full max-w-md space-y-3">
          {[
            {
              title: 'AI 全程不说教',
              body: '辩论中它只当对手，观察留到结束后才给 —— 不在你说话的时候打断你。',
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

        {/* ── 老用户入口（灰色小链接）──────────────────────── */}
        <div className="mt-12 text-center text-xs text-tertiary">
          <span>已有账号？</span>
          <Link to="/login" className="ml-1 underline hover:text-secondary">
            登录
          </Link>
          <span className="mx-1">·</span>
          <Link to="/register" className="underline hover:text-secondary">
            注册
          </Link>
        </div>
      </div>
    </div>
  );
}

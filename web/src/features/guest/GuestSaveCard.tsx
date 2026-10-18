import { Button } from '@/components/common/Button';

import { GUEST_COPY } from './copy';

interface GuestSaveCardProps {
  /** 打开认领弹窗 */
  onSave: () => void;
  /** 「先不保存」：把自己藏起来，顶部访客条仍然留着入口 */
  onLater: () => void;
}

/**
 * 复盘卡片下面的「保存这条观察」引导 —— 整条访客链路**唯一的转化点**。
 *
 * 【为什么放在复盘卡正下方】
 *
 * 这是用户第一次拿到有价值的东西（AI 的观察）的那一刻。在此之前
 * 提注册是没有说服力的 —— 他还没有任何值得保存的东西。放在这里，
 * 「保存」指向的是一个**具体对象**（刚才那条观察），不是一个抽象的产品。
 *
 * 【为什么是「保存」而不是「注册/升级/解锁」】
 *
 * 「保存」是一个用户已经理解、且此刻正好想做的动作（他刚看到一条
 * 关于自己的、有点意外的观察）。「注册」是一个产品需求，不是用户需求。
 * 同一件事，用用户的词说，转化率完全不同。
 *
 * 【为什么保留「先不保存」】
 *
 * 只给一个按钮是逼单。访客模式的价值恰恰是「不注册也能完整体验」，
 * 如果他此刻不想保存，让他走 —— 顶部访客条还在，数据 7 天内都在，
 * 他随时能回来。逼出来的账号第二天就不会再打开。
 */
export function GuestSaveCard({ onSave, onLater }: GuestSaveCardProps) {
  return (
    <section
      aria-label="保存这条观察"
      className="rounded-2xl border border-primary-light bg-primary-light px-4 py-4"
    >
      <p className="text-[15px] font-medium leading-snug text-primary">{GUEST_COPY.saveTitle}</p>
      <p className="mt-2 text-[13px] leading-relaxed text-secondary">{GUEST_COPY.saveBody}</p>

      <div className="mt-4 flex gap-2">
        <Button fullWidth onClick={onSave}>
          {GUEST_COPY.saveCta}
        </Button>
        <Button variant="ghost" onClick={onLater}>
          {GUEST_COPY.saveLater}
        </Button>
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-tertiary">
        {GUEST_COPY.saveRetention}
      </p>
    </section>
  );
}

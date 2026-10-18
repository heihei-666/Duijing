import { GUEST_COPY } from './copy';

interface GuestBannerProps {
  /** 打开认领弹窗 */
  onSave: () => void;
}

/**
 * 辩论房顶部的访客条。
 *
 * 【为什么除了复盘卡下面的卡片还要有它】
 *
 * 复盘卡下面那张是「转化点」，只在用户拿到观察之后出现；而用户辩到一半
 * 可能就想注册（或者误以为不注册会丢数据）。这条常驻在顶部，只做两件事：
 *   1. 告诉他现在的身份是访客 —— 否则他不知道「访客」意味着什么；
 *   2. 告诉他数据会保留 —— 否则他会担心「不注册是不是白辩了」。
 *
 * 它不打断、不弹窗、不遮任何东西，就是一行字加一个入口。
 * 那条卡片可以被「先不保存」关掉，这条不会 —— 门一直留着。
 */
export function GuestBanner({ onSave }: GuestBannerProps) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl bg-elevated px-3 py-2">
      <p className="min-w-0 text-[11px] leading-relaxed text-tertiary">
        <span className="text-secondary">{GUEST_COPY.roomBanner}</span>
        <span className="mx-1">·</span>
        {GUEST_COPY.roomBannerHint}
      </p>
      <button
        type="button"
        onClick={onSave}
        className="h-8 shrink-0 rounded-lg px-2 text-[12px] text-brand transition-colors hover:bg-inset"
      >
        保存
      </button>
    </div>
  );
}

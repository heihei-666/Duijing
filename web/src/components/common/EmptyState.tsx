interface EmptyStateProps {
  /** 一句话说明现在没有内容，克制、不喧哗 */
  title: string;
  /** 可选的下一步提示；没有就不写 */
  hint?: string;
  /**
   * 用哪张小插画。默认 `inbox`。
   * 全部是**线稿**（1.5px 描边 + currentColor），不用彩色填充 ——
   * 空状态不该比有内容时更抢眼，它只需要让那一块不显得「坏了」。
   */
  art?: 'inbox' | 'mirror' | 'seed';
}

/**
 * 空状态插画。
 *
 * 【为什么这一版加了插画】
 *
 * 上一版只有一行灰字。问题是：一整块区域里只有 13px 的灰字，
 * 视觉上跟「加载失败」和「这里什么都没有」长得一模一样 ——
 * 用户分不清是「我还没做」还是「功能坏了」。
 *
 * 一张**很淡的线稿**能同时说明三件事：这里确实有东西、现在是空的、
 * 而且它看起来是设计过的（不是坏掉的）。
 *
 * 刻意做得大而淡（96px、opacity 60%）：它是背景衬托，不是主角。
 */
function EmptyArt({ art }: { art: NonNullable<EmptyStateProps['art']> }) {
  const base = {
    width: 96,
    height: 96,
    viewBox: '0 0 96 96',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.5,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true,
  };

  if (art === 'mirror') {
    // 一面镜子 + 一道反光：对应「照见自己」这个产品隐喻
    return (
      <svg {...base}>
        <ellipse cx="48" cy="42" rx="24" ry="30" />
        <path d="M35 30c-3 4-4.5 9-4.5 14" />
        <path d="M42 74v8M54 74v8M34 86h28" />
      </svg>
    );
  }

  if (art === 'seed') {
    // 一颗种子 + 破土：对应「攒出来的」原则
    return (
      <svg {...base}>
        <path d="M48 78V52" />
        <path d="M48 58c-10 0-17-6-18-16 10 0 17 6 18 16z" />
        <path d="M48 52c9 0 15-5 16-14-9 0-15 5-16 14z" />
        <path d="M32 78h32" />
      </svg>
    );
  }

  // inbox：一个空的收纳盒，对应「还没有记录」
  return (
    <svg {...base}>
      <path d="M16 56h16l4 8h24l4-8h16" />
      <path d="M20 56 30 26h36l10 30v18a4 4 0 0 1-4 4H24a4 4 0 0 1-4-4z" />
      <path d="M40 40h16" />
    </svg>
  );
}

/**
 * 各块空状态（方案 3.7：空状态各块自行收形）。
 * 不用彩色、不用实心块，避免把「没有内容」也做成一种强调。
 */
export function EmptyState({ title, hint, art = 'inbox' }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center px-4 py-10 text-center">
      <span className="text-disabled opacity-70">
        <EmptyArt art={art} />
      </span>
      <p className="mt-4 text-[14px] text-secondary">{title}</p>
      {hint ? <p className="mt-1.5 text-xs leading-relaxed text-tertiary">{hint}</p> : null}
    </div>
  );
}

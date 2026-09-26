/**
 * 撑住率取色（配色方案 四·撑住率配色）
 *
 *   0–40%   #B85C5C  砖红，破功多，还在挣扎
 *   40–60%  #C4944A  琥珀，一半一半
 *   60–80%  #5B8C6B  灰绿，在改善
 *   80–100% #4A8C5C  深绿，达标，可降级
 *
 * 返回的是 CSS 变量引用（如 `var(--rate-good)`）而不是硬编码色值，
 * 便于以后整体换色；直接用于 inline style：
 *   <span style={{ color: rateColor(rate) }} />
 *   <div style={{ backgroundColor: rateColor(rate) }} />
 *
 * ⚠️ 「没有数据」和「0%」是两件事，必须分开（后端契约见
 * app/services/serializers.py：hold_rate_30d 是 int | None）：
 *   null → 还没有触发记录（刚建的回环、或只记过「未触发」）→ 显示 `--` + 中性色
 *   0    → 真的每次都破功 → 显示 `0%` + --rate-low
 * 把 null 画成 0% 会让刚建好回环的人以为自己一直在失败，而他一次都还没练过。
 * 所有取值函数都接受 `RateValue`，调用方不需要自己判空。
 */

/** 取色断点，左闭右开 */
const RATE_STOPS = [
  { max: 40, token: 'var(--rate-low)' },
  { max: 60, token: 'var(--rate-mid)' },
  { max: 80, token: 'var(--rate-good)' },
  { max: Infinity, token: 'var(--rate-great)' },
] as const;

/**
 * 撑住率取值：number 为真实数据，null / undefined 表示还没有触发记录。
 * 后端的 `hold_rate_30d` 就是 `int | None`，前端类型声明里写成 number
 * 只是为了不改 `api/types.ts`，运行时必须按可空处理。
 */
export type RateValue = number | null | undefined;

/** 没有数据时显示的占位符（不是 0%） */
export const RATE_EMPTY_TEXT = '--';

/** 没有数据时的轻量说明（一行小字，不喧哗） */
export const RATE_EMPTY_NOTE = '还没有记录';

/** 没有数据时的中性色：不用 --rate-low，避免被读成「持续失败」 */
export const RATE_EMPTY_COLOR = 'var(--text-disabled)';

/** 有真实数值吗？null / undefined / NaN 都算「还没有记录」 */
export function hasRate(rate: RateValue): rate is number {
  return typeof rate === 'number' && Number.isFinite(rate);
}

/** 把任意输入收敛到 0–100（非有限数按 0 处理，只用于已有数值的场景） */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  if (rate < 0) return 0;
  if (rate > 100) return 100;
  return rate;
}

/**
 * 撑住率 → 颜色（返回 CSS 变量引用）
 * 40 → 琥珀，60 → 灰绿，80 → 深绿（区间左闭右开）
 * 没有数据 → 中性色 --text-disabled
 */
export function rateColor(rate: RateValue): string {
  if (!hasRate(rate)) return RATE_EMPTY_COLOR;
  const value = clampRate(rate);
  for (const stop of RATE_STOPS) {
    if (value < stop.max) return stop.token;
  }
  return 'var(--rate-great)';
}

/** 撑住率 → 展示用百分比数字，如 67；没有数据时返回 null */
export function ratePercent(rate: RateValue): number | null {
  return hasRate(rate) ? Math.round(clampRate(rate)) : null;
}

/** 撑住率 → 展示用文本：有数据 "67%"，没有数据 "--" */
export function rateText(rate: RateValue): string {
  const percent = ratePercent(rate);
  return percent === null ? RATE_EMPTY_TEXT : `${percent}%`;
}

/**
 * 撑住率 → 一句克制的说明（用于 aria-label / title，不占用界面）。
 * 没有数据时是「还没有记录」，不是「偏低」。
 */
export function rateHint(rate: RateValue): string {
  if (!hasRate(rate)) return RATE_EMPTY_NOTE;
  const value = clampRate(rate);
  if (value < 40) return '近 30 天撑住率偏低';
  if (value < 60) return '近 30 天撑住率一半一半';
  if (value < 80) return '近 30 天撑住率在改善';
  return '近 30 天撑住率达标';
}

/** 撑住率 → 无障碍标签，如「近 30 天撑住率 67%」/「近 30 天撑住率 还没有记录」 */
export function rateAriaLabel(rate: RateValue): string {
  const percent = ratePercent(rate);
  return percent === null
    ? `近 30 天撑住率 ${RATE_EMPTY_NOTE}`
    : `近 30 天撑住率 ${percent}%`;
}

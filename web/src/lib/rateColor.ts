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
 */

/** 取色断点，左闭右开 */
const RATE_STOPS = [
  { max: 40, token: 'var(--rate-low)' },
  { max: 60, token: 'var(--rate-mid)' },
  { max: 80, token: 'var(--rate-good)' },
  { max: Infinity, token: 'var(--rate-great)' },
] as const;

/** 把任意输入收敛到 0–100 */
export function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 0;
  if (rate < 0) return 0;
  if (rate > 100) return 100;
  return rate;
}

/**
 * 撑住率 → 颜色（返回 CSS 变量引用）
 * 40 → 琥珀，60 → 灰绿，80 → 深绿（区间左闭右开）
 */
export function rateColor(rate: number): string {
  const value = clampRate(rate);
  for (const stop of RATE_STOPS) {
    if (value < stop.max) return stop.token;
  }
  return 'var(--rate-great)';
}

/** 撑住率 → 展示用百分比文本，如 67 */
export function ratePercent(rate: number): number {
  return Math.round(clampRate(rate));
}

/** 撑住率 → 展示用文本，如 "67%" */
export function rateText(rate: number): string {
  return `${ratePercent(rate)}%`;
}

/** 撑住率 → 一句克制的说明（用于 aria-label / title，不占用界面） */
export function rateHint(rate: number): string {
  const value = clampRate(rate);
  if (value < 40) return '近 30 天撑住率偏低';
  if (value < 60) return '近 30 天撑住率一半一半';
  if (value < 80) return '近 30 天撑住率在改善';
  return '近 30 天撑住率达标';
}

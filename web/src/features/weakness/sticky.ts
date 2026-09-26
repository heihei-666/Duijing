import type { WeaknessStatus } from '@/api/types';

/**
 * 弱点便签的四态视觉（配色方案 第三章「便签状态色汇总」，逐条对应）：
 *
 *   状态      底色              边框            文字
 *   AI 候选   --sticky-ai-bg    --sticky-ai-border 虚线   --sticky-ai-text
 *   观察中    --sticky-observing-bg 同上 虚线                --sticky-observing-text  旋转 -1.5deg
 *   改善中    --sticky-improving-bg 实线                    --sticky-improving-text  正贴
 *   暂存      --sticky-archived-bg  实线                    --sticky-archived-text   透明度 0.6 + 折角
 *
 * 四种状态从冷到暖再到灰，色相变化不超过 60 度；层级差异一律用**透明度**做，
 * 不再引入第五种颜色。
 */
export interface StickyTone {
  /** 便签容器：底色 + 边框（虚线/实线）+ 文字色 */
  card: string;
  /** 角标行的透明度修饰 */
  meta: string;
  /** 是否歪贴（观察中） */
  rotate: boolean;
  /** 是否角上折起（暂存） */
  folded: boolean;
  /** 右上角小图标 */
  icon: 'ai' | 'loop' | null;
}

export const STICKY_TONES: Record<WeaknessStatus, StickyTone> = {
  ai_candidate: {
    card: 'border border-dashed border-sticky-ai bg-sticky-ai text-sticky-ai',
    meta: 'opacity-70',
    rotate: false,
    folded: false,
    icon: 'ai',
  },
  observing: {
    card: 'border border-dashed border-sticky-observing bg-sticky-observing text-sticky-observing',
    meta: 'opacity-70',
    rotate: true,
    folded: false,
    icon: null,
  },
  improving: {
    card: 'border border-solid border-sticky-improving bg-sticky-improving text-sticky-improving',
    meta: 'opacity-60',
    rotate: false,
    folded: false,
    icon: 'loop',
  },
  archived: {
    card: 'border border-solid border-sticky-archived bg-sticky-archived text-sticky-archived',
    meta: 'opacity-70',
    rotate: false,
    folded: true,
    icon: null,
  },
};

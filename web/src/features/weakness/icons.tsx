import type { SVGProps } from 'react';

/**
 * 本次新增的图标（弱点墙 / 资产模块共用）。
 *
 * 为什么放这里而不是 `@/components/icons`：本次交付范围只允许动
 * `pages/{WeaknessesPage,WeaknessDetailPage,AssetsPage}.tsx` 与
 * `features/{weakness,assets}/**`，所以新增图标集中在本文件，两个模块共用一份，
 * 避免同一个图标写两遍。风格与 `components/icons` 保持一致：
 * 24×24 视窗、currentColor、1.6 描边、颜色交给外层类名。
 */

type IconProps = SVGProps<SVGSVGElement>;

const baseProps = {
  width: 24,
  height: 24,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  focusable: false,
};

/** AI 观察：四角星 + 小星，冷色由外层 text-sticky-ai / text-info 决定 */
export function AiIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M11 4.6l1.5 4.1 4.1 1.5-4.1 1.5L11 15.8 9.5 11.7 5.4 10.2l4.1-1.5z" />
      <path d="M17.4 15.2l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z" />
    </svg>
  );
}

/** 回环：闭环箭头（改善中便签右上角、回环状态都用它） */
export function LoopIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M6.4 9.2A6.2 6.2 0 0 1 17.6 8" />
      <path d="M17.6 4.6V8h-3.4" />
      <path d="M17.6 14.8A6.2 6.2 0 0 1 6.4 16" />
      <path d="M6.4 19.4V16h3.4" />
    </svg>
  );
}

/** 置信度星标：实心，颜色由外层决定（用主色，不用金色） */
export function StarIcon(props: IconProps) {
  return (
    <svg
      width={24}
      height={24}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      focusable={false}
      {...props}
    >
      <path d="M12 4.6l2.2 4.6 5 .7-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5L4.8 9.9l5-.7z" />
    </svg>
  );
}

/** 垃圾桶 */
export function TrashIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M5.6 7.4h12.8" />
      <path d="M9.6 7.4V5.6h4.8v1.8" />
      <path d="M7.2 7.4l.8 11a1 1 0 0 0 1 .9h6a1 1 0 0 0 1-.9l.8-11" />
      <path d="M10.6 10.8v5.4M13.4 10.8v5.4" />
    </svg>
  );
}

/** 折叠箭头（展开时旋转 180°） */
export function ChevronDownIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={18} height={18} {...props}>
      <path d="M6 9.5 12 15.5 18 9.5" />
    </svg>
  );
}

/** 更多操作（便签右上角按钮） */
export function MoreIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={20} height={20} {...props}>
      <circle cx="5.6" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="18.4" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** 新增 */
export function PlusIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={20} height={20} {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  );
}

/** 勾 */
export function CheckIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={18} height={18} {...props}>
      <path d="M5.5 12.6 9.6 16.6 18.5 7.6" />
    </svg>
  );
}

/** 复制 */
export function CopyIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={18} height={18} {...props}>
      <rect x="9" y="9" width="10.4" height="10.4" rx="2" />
      <path d="M15.4 6.6A2 2 0 0 0 13.4 4.6H6.6a2 2 0 0 0-2 2v6.8a2 2 0 0 0 2 2" />
    </svg>
  );
}

/** 置顶（图钉） */
export function PinIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={18} height={18} {...props}>
      <path d="M9.4 4.6h5.2l-.9 3.6 3 3v1.4h-4.2V20l-1.3 0v-7.4H7.1v-1.4l3-3z" />
    </svg>
  );
}

/** 关联（链接） */
export function LinkIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={18} height={18} {...props}>
      <path d="M10.2 13.8a3.4 3.4 0 0 1 0-4.8l2.4-2.4a3.4 3.4 0 0 1 4.8 4.8l-1.2 1.2" />
      <path d="M13.8 10.2a3.4 3.4 0 0 1 0 4.8l-2.4 2.4a3.4 3.4 0 0 1-4.8-4.8l1.2-1.2" />
    </svg>
  );
}

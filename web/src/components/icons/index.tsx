import type { SVGProps } from 'react';

/**
 * 手写图标（不引第三方图标库）。
 * 统一 24×24 视窗、currentColor 取色，颜色由外层 text-* 类控制。
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

/** 首页 */
export function HomeIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M4 10.6 12 4.2l8 6.4V19a1.4 1.4 0 0 1-1.4 1.4H5.4A1.4 1.4 0 0 1 4 19z" />
      <path d="M9.6 20.4v-5.6h4.8v5.6" />
    </svg>
  );
}

/** 辩论 */
export function DebateIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M4 7.2A2.2 2.2 0 0 1 6.2 5h6.6A2.2 2.2 0 0 1 15 7.2v2.6a2.2 2.2 0 0 1-2.2 2.2H8.4L5.2 14.6V12h-.0A2.2 2.2 0 0 1 4 9.8z" />
      <path d="M17.4 9.4h.4A2.2 2.2 0 0 1 20 11.6v2.6a2.2 2.2 0 0 1-2.2 2.2h-.4v2.6l-3.2-2.6h-2.6" />
    </svg>
  );
}

/** 弱点（便签） */
export function WeaknessIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M6.2 4h8.4l4.4 4.4V19a1 1 0 0 1-1 1H6.2a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M14.4 4v4.6H19" />
    </svg>
  );
}

/** 资产（优势 / 原则 / 事件卡） */
export function AssetsIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M12 3.6 20.2 8 12 12.4 3.8 8z" />
      <path d="M3.8 12.4 12 16.8l8.2-4.4" />
      <path d="M3.8 16.4 12 20.8l8.2-4.4" />
    </svg>
  );
}

/** 连续天数火苗：用 SVG 而不是 emoji，保证颜色就是 --warning */
export function FlameIcon(props: IconProps) {
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
      <path d="M12.9 2.4c.3 2.2-1.1 3.6-2.5 5C8.9 8.8 7.4 10.4 7.4 13a4.6 4.6 0 0 0 9.2.3c0-1.5-.6-2.4-1.2-3.3-.3.7-.9 1.2-1.6 1.4.4-2.8-.3-5.6-1-9z" />
    </svg>
  );
}

/** 列表右侧的小箭头 */
export function ChevronRightIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={16} height={16} {...props}>
      <path d="M9.5 5.5 16 12l-6.5 6.5" />
    </svg>
  );
}

/** 关闭 */
export function CloseIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={20} height={20} {...props}>
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

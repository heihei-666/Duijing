import type { SVGProps } from 'react';

/**
 * 辩论房局部图标。
 * 不引第三方图标库，也不去改公共的 `components/icons`（那是别人的交付范围），
 * 统一 24×24 视窗、currentColor 取色，颜色交给外层 text-* 控制。
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

/** 返回 */
export function BackIcon(props: IconProps) {
  return (
    <svg {...baseProps} {...props}>
      <path d="M14.5 5.5 8 12l6.5 6.5" />
    </svg>
  );
}

/** 新建 */
export function PlusIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={20} height={20} {...props}>
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  );
}

/** 复制链接 */
export function CopyIcon(props: IconProps) {
  return (
    <svg {...baseProps} width={16} height={16} {...props}>
      <rect x="9" y="9" width="10.5" height="10.5" rx="2" />
      <path d="M15 6.2A2.2 2.2 0 0 0 12.8 4H6.2A2.2 2.2 0 0 0 4 6.2v6.6c0 1.1.8 2 1.9 2.1" />
    </svg>
  );
}

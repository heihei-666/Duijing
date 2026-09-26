/**
 * 对镜 · Tailwind 主题
 *
 * 设计令牌唯一来源是 `src/styles/tokens.css`（配色方案第十章，逐字采用）。
 * 这里只做「类名 → CSS 变量」的映射，**不写死任何色值**，
 * 于是调色只需改 tokens.css 一处。
 *
 * 命名约定（刻意区分，避免歧义）：
 *   bg-base / bg-surface / bg-elevated / bg-inset   → --bg-*
 *   text-primary / text-secondary / text-tertiary   → --text-*（中性文字色）
 *   text-brand                                      → --primary（品牌蓝，用于链接/强调文字）
 *   bg-primary / text-on-brand                      → --primary / --primary-text（主按钮）
 *   bg-sticky-ai / border-sticky-ai / text-sticky-ai → --sticky-ai-*
 *   text-rate-low|mid|good|great                    → --rate-*
 *
 * 为什么不用一个扁平的 `colors: {}`：
 *   1. 若在 colors 里放 `base`，会生成 `.text-base { color: ... }`，
 *      与 Tailwind 内置字号 `.text-base` 撞名（后者可能被覆盖，正文直接变底色）。
 *      所以 `base` 只注册到 backgroundColor。
 *   2. textColor / backgroundColor 分开注册，才能让 `text-primary` 表示「主文字（暖黑）」、
 *      `bg-primary` 表示「主色底（灰蓝）」，两者语义各自成立。
 *
 * 注意：色值是 `var(--x)` 字符串，Tailwind 无法对它做透明度运算，
 * 因此不要写 `bg-primary/10` 这类透明度修饰符，请使用 --primary-light 等浅色变体。
 */

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 供 border-*/ring-*/fill-* 等通用颜色工具使用（不含 base，见文件头说明）
        primary: {
          DEFAULT: 'var(--primary)',
          hover: 'var(--primary-hover)',
          light: 'var(--primary-light)',
        },
        success: {
          DEFAULT: 'var(--success)',
          light: 'var(--success-light)',
        },
        warning: {
          DEFAULT: 'var(--warning)',
          light: 'var(--warning-light)',
        },
        danger: {
          DEFAULT: 'var(--danger)',
          light: 'var(--danger-light)',
        },
        info: {
          DEFAULT: 'var(--info)',
          light: 'var(--info-light)',
        },
        light: 'var(--border-light)',
        strong: 'var(--border-strong)',
      },
      backgroundColor: {
        base: 'var(--bg-base)',
        surface: 'var(--bg-surface)',
        elevated: 'var(--bg-elevated)',
        inset: 'var(--bg-inset)',
        'sticky-ai': 'var(--sticky-ai-bg)',
        'sticky-observing': 'var(--sticky-observing-bg)',
        'sticky-improving': 'var(--sticky-improving-bg)',
        'sticky-archived': 'var(--sticky-archived-bg)',
        // 撑住率底色：进度条目前用 rateColor() 内联上色，这里给需要纯底色块的场景备用
        'rate-low': 'var(--rate-low)',
        'rate-mid': 'var(--rate-mid)',
        'rate-good': 'var(--rate-good)',
        'rate-great': 'var(--rate-great)',
      },
      textColor: {
        // 中性文字
        primary: 'var(--text-primary)',
        secondary: 'var(--text-secondary)',
        tertiary: 'var(--text-tertiary)',
        disabled: 'var(--text-disabled)',
        // 品牌色文字（主按钮上的字、链接）
        brand: 'var(--primary)',
        'brand-hover': 'var(--primary-hover)',
        'on-brand': 'var(--primary-text)',
        // 功能色文字
        success: 'var(--success)',
        warning: 'var(--warning)',
        danger: 'var(--danger)',
        info: 'var(--info)',
        // 弱点便签文字
        'sticky-ai': 'var(--sticky-ai-text)',
        'sticky-observing': 'var(--sticky-observing-text)',
        'sticky-improving': 'var(--sticky-improving-text)',
        'sticky-archived': 'var(--sticky-archived-text)',
        // 撑住率
        'rate-low': 'var(--rate-low)',
        'rate-mid': 'var(--rate-mid)',
        'rate-good': 'var(--rate-good)',
        'rate-great': 'var(--rate-great)',
      },
      borderColor: {
        light: 'var(--border-light)',
        strong: 'var(--border-strong)',
        'sticky-ai': 'var(--sticky-ai-border)',
        'sticky-observing': 'var(--sticky-observing-border)',
        'sticky-improving': 'var(--sticky-improving-border)',
        'sticky-archived': 'var(--sticky-archived-border)',
      },
      divideColor: {
        light: 'var(--border-light)',
      },
      ringColor: {
        primary: 'var(--primary)',
        danger: 'var(--danger)',
      },
      fill: {
        primary: 'var(--primary)',
        warning: 'var(--warning)',
        'sticky-ai': 'var(--sticky-ai-text)',
      },
      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"Segoe UI"',
          '"PingFang SC"',
          '"Hiragino Sans GB"',
          '"Microsoft YaHei"',
          '"Noto Sans CJK SC"',
          '"Source Han Sans SC"',
          'sans-serif',
        ],
      },
      boxShadow: {
        card: '0 1px 2px 0 rgba(44, 42, 38, 0.04)',
        sheet: '0 -8px 24px rgba(44, 42, 38, 0.10)',
      },
      keyframes: {
        'fade-in': {
          from: { opacity: '0' },
          to: { opacity: '1' },
        },
        'sheet-up': {
          from: { transform: 'translateY(100%)' },
          to: { transform: 'translateY(0)' },
        },
      },
      animation: {
        'fade-in': 'fade-in 150ms ease-out',
        'sheet-up': 'sheet-up 180ms ease-out',
      },
    },
  },
  plugins: [],
};

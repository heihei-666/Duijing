import { create } from 'zustand';

/**
 * 白天 / 黑夜模式。
 *
 * 【为什么用 CSS 变量翻，而不是 Tailwind 的 dark: 变体】
 *
 * 全站颜色都走 tokens（`tailwind.config.js` 只做「类名 → var(--x)」映射），
 * 暗色主题只是 `styles/tokens.css` 里另一组变量值（`[data-theme='dark']`）。
 * 于是换肤是**改一个 DOM 属性**，一个组件都不用动。
 * 若用 `dark:` 变体，就要在几十个组件里补一遍类名，必然漏几个。
 *
 * 【三态还是两态】
 *
 * 用户要的是「白天 / 黑夜切换」，所以只做两态，不引入 auto。
 * 但**首次访问**会跟随系统（`prefers-color-scheme`）—— 一个已经开了全局暗色的
 * 用户，第一眼看到一屏刺眼的白，会觉得这个产品不尊重他的设置。
 * 只要他手动切过一次，之后就一直按他选的来（写 localStorage）。
 */
export type ThemeMode = 'light' | 'dark';

const STORAGE_KEY = 'dj:theme';

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  } catch {
    return false;
  }
}

function readSaved(): ThemeMode | null {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === 'light' || saved === 'dark' ? saved : null;
  } catch {
    // 隐私模式下 localStorage 会抛异常：按「没存过」处理，不影响使用
    return null;
  }
}

/**
 * 把主题写到 DOM 上。
 *
 * 除了 `data-theme`，还要同步两个东西：
 *   · `<meta name="theme-color">` —— 手机浏览器的地址栏/状态栏颜色，不同步会很割裂
 *   · `color-scheme`（在 CSS 里）—— 让原生控件（滚动条、日期选择器）也跟着变
 */
function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.dataset.theme = mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', mode === 'dark' ? '#191816' : '#4A6FA5');
}

interface ThemeState {
  mode: ThemeMode;
  /** 手动切换（会记住选择） */
  toggle: () => void;
  setMode: (mode: ThemeMode) => void;
}

const initialMode: ThemeMode = readSaved() ?? (systemPrefersDark() ? 'dark' : 'light');

// 模块加载即应用一次：避免首屏闪一下亮色再切暗（FOUC）
applyTheme(initialMode);

export const useThemeStore = create<ThemeState>()((set, get) => ({
  mode: initialMode,

  setMode: (mode) => {
    applyTheme(mode);
    try {
      window.localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      /* 存不了就只在本次会话生效 */
    }
    set({ mode });
  },

  toggle: () => get().setMode(get().mode === 'dark' ? 'light' : 'dark'),
}));

import { useEffect } from 'react';
import type { ReactNode } from 'react';

import { CloseIcon } from '@/components/icons';

interface SheetProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

/**
 * 弹层：**窄屏是底部抽屉，宽屏是居中弹窗**。
 *
 * 【为什么宽屏要换形态】
 *
 * 底部抽屉是移动端的形态，为的是拇指够得着。在 1440px 的浏览器里，
 * 一个面板从窗口最底部升起 —— 视线要往下跑很远，而且和「弹出一个对话框」
 * 这个心理预期不符。桌面应用的标准是居中。
 *
 * 【为什么窄屏不改】
 *
 * 手机上一旦居中，内容就跑到屏幕上半部分，单手够不着；
 * 而且键盘弹起时居中弹窗会被顶得很难看。底部抽屉在这两种情况下都更稳。
 *
 * 【断点选 lg（1024px）】
 *
 * 和主框架一致（`AppShell` 也是 lg 起切左侧导航）——
 * 两处断点不同的话，会出现「侧边栏已经切了、弹层还没切」的中间态。
 */
export function Sheet({ open, title, onClose, children, footer }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center lg:items-center lg:p-6"
      role="dialog"
      aria-modal
    >
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in cursor-default bg-[rgba(44,42,38,0.32)]"
      />
      {/*
        窄屏：贴底、只圆上面两角、上边框分隔、向上投影
        宽屏：居中、四角全圆、四周描边、向下投影、限高可滚

        `lg:max-h-[85vh] lg:overflow-y-auto` 是必需的：弹层内容会长
        （邀请好友的列表、创建回环的表单），居中之后如果超出视口，
        没有限高就会被截断且无法滚动。
      */}
      <div className="relative w-full max-w-2xl animate-sheet-up rounded-t-2xl border-t border-light bg-surface shadow-sheet dj-safe-bottom lg:max-h-[85vh] lg:max-w-xl lg:overflow-y-auto lg:rounded-2xl lg:border lg:shadow-modal">
        <header className="flex items-center justify-between px-5 pt-4">
          <h2 className="text-[15px] font-medium text-primary">{title}</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="-mr-1 rounded-lg p-1 text-tertiary hover:bg-elevated"
          >
            <CloseIcon />
          </button>
        </header>
        <div className="px-5 pb-2 pt-4">{children}</div>
        {footer ? <div className="px-5 pb-5 pt-2">{footer}</div> : null}
      </div>
    </div>
  );
}

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
 * 底部抽屉（移动端优先）。
 * 桌面端同样从底部升起，但内容居中限宽，和主框架对齐。
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
    <div className="fixed inset-0 z-50 flex items-end justify-center" role="dialog" aria-modal>
      <button
        type="button"
        aria-label="关闭"
        onClick={onClose}
        className="absolute inset-0 animate-fade-in cursor-default bg-[rgba(44,42,38,0.32)]"
      />
      <div className="relative w-full max-w-2xl animate-sheet-up rounded-t-2xl border-t border-light bg-surface shadow-sheet dj-safe-bottom">
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

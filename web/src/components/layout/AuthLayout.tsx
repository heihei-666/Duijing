import type { ReactNode } from 'react';

interface AuthLayoutProps {
  title: string;
  subtitle?: string;
  children: ReactNode;
  footer?: ReactNode;
}

/** 登录 / 注册 / 邀请码落地页共用的居中布局 */
export function AuthLayout({ title, subtitle, children, footer }: AuthLayoutProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-base px-5 py-10">
      <div className="w-full max-w-sm">
        <header className="mb-6 text-center">
          <h1 className="text-xl font-medium tracking-[0.2em] text-primary">对镜</h1>
          <p className="mt-2 text-xs text-tertiary">用 AI 辩论房照见自己</p>
        </header>

        <div className="rounded-2xl border border-light bg-surface p-5 shadow-card">
          <h2 className="text-[15px] font-medium text-primary">{title}</h2>
          {subtitle ? <p className="mt-1 text-xs text-tertiary">{subtitle}</p> : null}
          <div className="mt-5">{children}</div>
        </div>

        {footer ? <div className="mt-5 text-center text-[13px]">{footer}</div> : null}
      </div>
    </div>
  );
}

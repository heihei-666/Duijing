import type { ReactNode } from 'react';

interface PageScaffoldProps {
  title: string;
  description: string;
  /** 后续要实现的内容清单，仅作为交接提示 */
  todos: string[];
  children?: ReactNode;
}

/**
 * 占位页骨架。辩论 / 弱点 / 资产三个 Tab 本阶段只到这里，
 * 具体业务由后续同事实现，这里不做任何假数据和假交互。
 */
export function PageScaffold({ title, description, todos, children }: PageScaffoldProps) {
  return (
    <section className="space-y-5">
      <header className="space-y-1.5">
        <h1 className="text-lg font-medium text-primary">{title}</h1>
        <p className="text-[13px] leading-relaxed text-secondary">{description}</p>
      </header>

      {children}

      <div className="rounded-2xl border border-dashed border-strong bg-surface p-4">
        <p className="text-xs text-tertiary">本页待实现</p>
        <ul className="mt-2 space-y-1.5">
          {todos.map((item) => (
            <li key={item} className="flex gap-2 text-[13px] text-secondary">
              <span aria-hidden className="text-disabled">
                ·
              </span>
              <span>{item}</span>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

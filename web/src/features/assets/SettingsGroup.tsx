import type { ReactNode } from 'react';

/**
 * 设置页的一个分组。
 *
 * 【为什么要这个容器】
 *
 * 设置页的项目会持续变多（改密码、通知、导出、注销、管理……）。
 * 每加一个都手写一遍 `<section>` + `<h3>` + 标题文案的话，
 * 样式和间距迟早会各自漂移，而且「这个模块属于哪一组」这件事
 * 会散落在 JSX 里，看不出结构。
 *
 * 【怎么加内容】
 *
 * 组里放 `SettingsRow`：
 *
 *   <SettingsGroup title="账号">
 *     <SettingsRow label="修改密码" description="…">按钮</SettingsRow>
 *   </SettingsGroup>
 *
 * **加一个模块 = 加一行；加一个分组 = 加一处。** 就这么多。
 */
export function SettingsGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-xl bg-surface px-4 py-4">
      <h3 className="text-[13px] text-secondary">{title}</h3>
      {/* divide-y：行之间自动出一条分隔线，行自己不用管边界。
          这样加行/删行都不需要调整相邻行的样式。 */}
      <div className="mt-3 divide-y divide-light">{children}</div>
    </section>
  );
}

interface SettingsRowProps {
  label: string;
  /** 可选说明。写「为什么需要这一步」，不写「点击这里」之类废话。 */
  description?: string;
  /** 行内的补充内容（状态文案、提示等），排在说明下方、动作上方 */
  children?: ReactNode;
  /** 动作区：按钮或按钮组。会右对齐到行的右侧 */
  action?: ReactNode;
}

/**
 * 设置页的一行：**标签 + 说明在左，动作在右**。
 *
 * 【为什么动作右对齐】
 *
 * 设置页是「扫一眼找东西」的地方。动作左对齐会让每行的高度和长度都不一样，
 * 眼睛没有固定的落点；右对齐之后按钮排成一列，扫视成本低得多。
 *
 * 窄屏下按钮会换到下一行（`flex-wrap`）—— 手机上左右并排在 320px 里挤不下。
 */
export function SettingsRow({ label, description, children, action }: SettingsRowProps) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] text-secondary">{label}</p>
        {description ? (
          <p className="mt-1 text-xs leading-relaxed text-tertiary">{description}</p>
        ) : null}
        {children}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

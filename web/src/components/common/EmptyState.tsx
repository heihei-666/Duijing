interface EmptyStateProps {
  /** 一句话说明现在没有内容，克制、不喧哗 */
  title: string;
  /** 可选的下一步提示；没有就不写 */
  hint?: string;
}

/**
 * 各块空状态（方案 3.7：空状态各块自行收形）。
 * 不画插图、不用彩色，避免把「没有内容」也做成一种强调。
 */
export function EmptyState({ title, hint }: EmptyStateProps) {
  return (
    <div className="py-5 text-center">
      <p className="text-[13px] text-secondary">{title}</p>
      {hint ? <p className="mt-1 text-xs text-tertiary">{hint}</p> : null}
    </div>
  );
}

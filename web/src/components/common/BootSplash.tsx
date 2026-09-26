/** 会话恢复期间的过渡页：只放名字，不放 loading 文案以外的任何东西 */
export function BootSplash() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-base">
      <span className="text-lg font-medium tracking-[0.2em] text-primary">对镜</span>
      <span className="mt-3 text-xs text-tertiary">正在打开…</span>
    </div>
  );
}

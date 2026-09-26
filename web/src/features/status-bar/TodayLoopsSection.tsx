import { EmptyState } from '@/components/common/EmptyState';
import { ChevronRightIcon } from '@/components/icons';
import { RateBar } from '@/features/status-bar/RateBar';
import { rateColor, ratePercent, rateHint } from '@/lib/rateColor';
import type { TodayLoop } from '@/api/types';

interface TodayLoopsSectionProps {
  loops: TodayLoop[];
  onSelect: (loop: TodayLoop) => void;
}

/**
 * 状态栏第二块「今天练什么」：最多 2 条回环，按撑住率升序（最该练的在前，服务端已排好）。
 * 条目本身是中性色，只有撑住率数字和进度条按撑住率色板取色。
 */
export function TodayLoopsSection({ loops, onSelect }: TodayLoopsSectionProps) {
  return (
    <section className="rounded-2xl border border-light bg-surface shadow-card">
      <h2 className="px-4 pt-4 text-xs text-secondary">今天练什么</h2>

      {loops.length === 0 ? (
        <div className="px-4 pb-2">
          <EmptyState title="还没有在练的回环" hint="在弱点墙建一条回环，它就会出现在这里。" />
        </div>
      ) : (
        <ul className="mt-1 divide-y divide-light">
          {loops.map((loop) => {
            const percent = ratePercent(loop.hold_rate_30d);
            return (
              <li key={loop.loop_id}>
                <button
                  type="button"
                  onClick={() => onSelect(loop)}
                  className="w-full px-4 py-3 text-left transition-colors hover:bg-elevated"
                >
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate text-[15px] text-primary">
                      {loop.title}
                    </span>
                    <span className="shrink-0 text-xs text-tertiary">撑住率</span>
                    <span
                      className="shrink-0 text-[13px] font-medium tabular-nums"
                      style={{ color: rateColor(loop.hold_rate_30d) }}
                      title={rateHint(loop.hold_rate_30d)}
                    >
                      {percent}%
                    </span>
                    <ChevronRightIcon className="shrink-0 text-disabled" />
                  </div>
                  <RateBar rate={loop.hold_rate_30d} className="mt-2.5" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

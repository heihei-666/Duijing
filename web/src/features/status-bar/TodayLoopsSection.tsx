import { Button } from '@/components/common/Button';
import { ChevronRightIcon } from '@/components/icons';
import { RateBar } from '@/features/status-bar/RateBar';
import { rateColor, rateHint, ratePercent, rateText } from '@/lib/rateColor';
import { cn } from '@/lib/cn';
import type { TodayLoop } from '@/api/types';

interface TodayLoopsSectionProps {
  loops: TodayLoop[];
  onSelect: (loop: TodayLoop) => void;
  /**
   * 空状态里的「开始」：不跳辩论列表，直接开一场即兴辩论（首页 Cold start 改造）。
   * 不传就只显示说明文案，留给以后复用。
   */
  onQuickDebate?: () => void;
  /**
   * 全新用户状态：底部按钮被隐藏，卡片要向下延伸填满原本的空间，
   * 否则整页会显得头重脚轻。
   */
  spacious?: boolean;
}

/**
 * 状态栏第二块「今天练什么」：最多 2 条回环，按撑住率升序（最该练的在前，服务端已排好）。
 * 条目本身是中性色，只有撑住率数字和进度条按撑住率色板取色。
 *
 * 空状态对新用户是第一屏：不写「还没有在练的回环」这种被动告知，
 * 直接给一个能点、且点了一定有结果的入口（即兴辩论 → 一轮之后自然长出回环）。
 */
export function TodayLoopsSection({
  loops,
  onSelect,
  onQuickDebate,
  spacious = false,
}: TodayLoopsSectionProps) {
  return (
    <section className="rounded-2xl border border-light bg-surface shadow-card">
      <h2 className="px-4 pt-4 text-xs text-secondary">今天练什么</h2>

      {loops.length === 0 ? (
        <div className={cn('px-4 text-center', spacious ? 'pb-9 pt-6' : 'pb-4 pt-1')}>
          <p className="text-[15px] leading-relaxed text-primary">
            想不想来一次 3 分钟的即兴辩论？
          </p>
          <p className={cn('text-xs text-tertiary', spacious ? 'mt-2' : 'mt-1')}>
            不用准备，选个立场就能开始。
          </p>
          {onQuickDebate ? (
            <Button size="lg" className={spacious ? 'mt-5' : 'mt-3'} onClick={onQuickDebate}>
              开始
            </Button>
          ) : null}
        </div>
      ) : (
        <ul className="mt-1 divide-y divide-light">
          {loops.map((loop) => {
            // 还没有触发记录（null）时显示 --，不能画成 0%（那是「每次都破功」）
            const empty = ratePercent(loop.hold_rate_30d) === null;
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
                      {rateText(loop.hold_rate_30d)}
                    </span>
                    <ChevronRightIcon className="shrink-0 text-disabled" />
                  </div>
                  <RateBar rate={loop.hold_rate_30d} className="mt-2.5" />
                  {empty ? (
                    <span className="mt-1.5 block text-[11px] text-tertiary">
                      还没有记录，练一次才会开始统计。
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

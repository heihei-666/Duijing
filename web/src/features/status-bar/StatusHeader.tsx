import { FlameIcon } from '@/components/icons';
import { formatDateWithWeekday } from '@/lib/date';

interface StatusHeaderProps {
  date: string;
  weekday: string;
  /** null 表示今天还没填 */
  energy: number | null;
  streakDays: number;
  onEditEnergy: () => void;
}

/**
 * 状态栏第一块：日期 + 星期 + 精力 + 连续天数（方案 3.7 / 配色方案 六）。
 * 状态栏只有两个彩色元素，这里是其一：连续天数的火苗色 --warning。
 */
export function StatusHeader({
  date,
  weekday,
  energy,
  streakDays,
  onEditEnergy,
}: StatusHeaderProps) {
  return (
    <header className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-secondary">{formatDateWithWeekday(date, weekday)}</p>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onEditEnergy}
          aria-label={energy === null ? '填写今天的精力' : `今天的精力 ${energy}，点击修改`}
          className="-mr-2 rounded-lg px-2 py-1 transition-colors hover:bg-elevated"
        >
          {energy === null ? (
            <span className="text-xs text-tertiary">+ 精力</span>
          ) : (
            <span className="flex items-baseline gap-1.5">
              <span className="text-xs text-secondary">精力</span>
              <span className="text-[15px] tabular-nums text-primary">{energy}</span>
            </span>
          )}
        </button>

        {streakDays > 0 ? (
          <span className="flex items-center gap-1 text-[13px] text-warning">
            <FlameIcon width={14} height={14} />
            <span className="tabular-nums">{streakDays} 天</span>
          </span>
        ) : null}
      </div>
    </header>
  );
}

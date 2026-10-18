import { FlameIcon } from '@/components/icons';
import { cn } from '@/lib/cn';
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
 * 「精力」电池条。
 *
 * 【为什么不用一个数字】
 *
 * 原来这里是「精力 72」两个字符。数字要经过一次心算才知道是多是少 ——
 * 而精力是这个产品里唯一一个**身体状态**指标，它应该被一眼看见，不该被读。
 * 电池条把「还剩多少」直接画出来：半满就是半满，不用想。
 *
 * 【为什么不做红黄绿分级】
 *
 * 「精力 30」被画成红色，等于在说「你状态很差」。这个产品整天在避免评判用户，
 * 一个身体指标更不该打分。所以只用主色画「有多少」，不画「好不好」。
 * （连续天数的火苗色是唯一的例外，那是奖励不是评价。）
 */
function EnergyBattery({ value }: { value: number }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <span aria-hidden className="flex items-center gap-[2px]">
      <span className="relative flex h-[13px] w-[24px] items-center rounded-[3px] border border-strong p-[1.5px]">
        <span
          className="h-full rounded-[1px] bg-brand transition-[width] duration-300"
          style={{ width: `${pct}%` }}
        />
      </span>
      {/* 电池正极的小凸头 */}
      <span className="h-[6px] w-[2px] rounded-r-sm bg-strong" />
    </span>
  );
}

/**
 * 状态栏第一块：日期 + 星期 + 精力 + 连续天数（方案 3.7 / 配色方案 六）。
 *
 * 精力做成一枚**小胶囊**：空的时候是「+ 精力」，填过之后变成「电池 + 数字」。
 * 胶囊有个浅描边，比纯文字更像「可以点」的东西 —— 原来那个 `+ 精力`
 * 是裸文字，视觉模型和真实用户都看不出它能点。
 */
export function StatusHeader({
  date,
  weekday,
  energy,
  streakDays,
  onEditEnergy,
}: StatusHeaderProps) {
  const filled = energy !== null;

  return (
    <header className="flex items-center justify-between gap-3">
      <p className="text-[13px] text-secondary">{formatDateWithWeekday(date, weekday)}</p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onEditEnergy}
          aria-label={filled ? `今天的精力 ${energy}，点击修改` : '填写今天的精力'}
          className={cn(
            'flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors',
            filled
              ? 'border-light bg-surface text-secondary hover:bg-elevated'
              : 'border-dashed border-strong text-tertiary hover:bg-elevated',
          )}
        >
          {filled ? (
            <>
              {/* 填过之后也要有「精力」两个字：只剩电池 + 数字时，
                  不看图标的人不知道 50 是什么的 50（看截图时发现的）。 */}
              <span className="text-[11px] text-tertiary">精力</span>
              <EnergyBattery value={energy} />
              <span className="tabular-nums text-primary">{energy}</span>
            </>
          ) : (
            <>
              {/* 空电池 + 加号：一眼知道「这里能填一个数」 */}
              <EnergyBattery value={0} />
              <span>精力</span>
            </>
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

import type { PastYou } from '@/api/types';

interface PastYouSectionProps {
  data: PastYou;
}

/**
 * 「过去的你」—— 首次记录 vs 最近一周。
 *
 * 【为什么这块是留存的关键】
 *
 * 改善弱点这件事反人性、很累。指望用户为了「改掉缺点」每天打卡不现实。
 * 真正能把人留住的，是**「我真的在变」的实感** ——
 * 而这个实感不能靠一句安慰，得靠可对照的数字。
 *
 * 【为什么措辞一个判断词都没有】
 *
 * 这块只在用户**状态变差**时最容易出问题。如果写「你退步了」，
 * 那这个产品就又变回了它本来要逃离的那种东西（审判）。
 *
 * 所以这里只做三件事：
 *   1. 把两个数字并排摆出来（事实）
 *   2. 变化方向只用中性词描述（「高一些 / 低一些 / 一样」）
 *   3. 变差时明确说「这不代表你退步了」，并给一句真实的原因
 *      （记录越多，撞上的场景就越难 —— 这不是安慰，是统计学）
 */
export function PastYouSection({ data }: PastYouSectionProps) {
  const { days_ago, early_rate, recent_rate, early_total, recent_total } = data;

  const trend =
    recent_rate > early_rate ? 'up' : recent_rate < early_rate ? 'down' : 'same';

  const note =
    trend === 'up'
      ? '它没有消失，但你跟它相处的方式在变。'
      : trend === 'down'
        ? // 变差时**绝不**说「退步」。记录变多，撞上的场景也会更难，
          // 这是真实原因，不是安慰话术。
          '这个数字会波动。记下的场景越多，撞上的就越难，它不代表你退步了。'
        : '稳定也是一种状态 —— 不是所有时候都在往上走。';

  return (
    <section
      aria-label="过去的你"
      className="rounded-2xl border border-light bg-surface px-4 py-4"
    >
      <p className="text-[11px] text-tertiary">过去的你</p>

      <div className="mt-3 flex items-end gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-[11px] text-tertiary">{days_ago} 天前</p>
          <p className="mt-1 text-[20px] font-medium tabular-nums text-primary">
            {early_rate}%
          </p>
          <p className="text-[11px] text-tertiary">撑住 {early_total} 次里</p>
        </div>

        <span aria-hidden className="mb-4 text-[13px] text-disabled">
          →
        </span>

        <div className="min-w-0 flex-1 text-right">
          <p className="text-[11px] text-tertiary">最近一周</p>
          <p className="mt-1 text-[20px] font-medium tabular-nums text-primary">
            {recent_rate}%
          </p>
          <p className="text-[11px] text-tertiary">撑住 {recent_total} 次里</p>
        </div>
      </div>

      <p className="mt-3 text-[12px] leading-relaxed text-secondary">{note}</p>
    </section>
  );
}

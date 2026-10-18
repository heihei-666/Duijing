import { Button } from '@/components/common/Button';
import type { StatusBarObservation } from '@/api/types';

interface ObservationSectionProps {
  observations: StatusBarObservation[];
  /** 正在提交的观察 id，用于禁用按钮 */
  pendingId: number | null;
  error: string | null;
  onAccept: (id: number) => void;
  onIgnore: (id: number) => void;
}

/**
 * 「AI 观察」：--sticky-ai-bg 冷灰蓝底，和用户内容区分（配色方案 六）。
 * 正文用暖黑保证可读性，只有标题 / 角标 / 「加入」用 AI 冷色。
 * 24 小时规则由服务端控制，前端只负责展示与处理。
 *
 * 【没有观察时整块不渲染 —— 这是本轮最重要的一次删除】
 *
 * 上一版的空状态长这样：
 *   「记录一个你今天不爽的瞬间，AI 帮你看看盲区。」+ 一个「记一笔」按钮
 * 而首页第一张卡（事件卡）写的是：
 *   「今天有什么让你不爽的瞬间？」「记一笔，AI 帮你看看盲区。」
 *   + 一个「记一笔」按钮
 *
 * **同一屏两个功能相同的入口、两段几乎逐字相同的文案。** 用户的原话是
 * 「严重的功能重叠和视觉打架」—— 他没有夸张。
 *
 * 现在这块只做一件事：**有真实观察时把 AI 的洞察摆出来**。
 * 没有就不存在。位置由调用方决定（`data.observations.length > 0`），
 * 组件自己再判一次，是为了让「空的时候不渲染」这条约束不依赖调用方记得。
 */
export function ObservationSection({
  observations,
  pendingId,
  error,
  onAccept,
  onIgnore,
}: ObservationSectionProps) {
  if (observations.length === 0) return null;

  return (
    <section className="rounded-2xl border border-sticky-ai bg-sticky-ai px-4 py-4">
      <h2 className="text-xs text-sticky-ai">AI 观察</h2>

      <ul className="mt-3 space-y-4">
        {observations.map((observation) => {
          const pending = pendingId === observation.id;
          const disabled = pendingId !== null;
          return (
            <li key={observation.id}>
              <div className="flex items-start gap-2">
                <span className="mt-[3px] shrink-0 rounded-md bg-surface px-1.5 py-0.5 text-[10px] leading-4 text-sticky-ai">
                  {observation.type === 'weakness' ? '弱点' : '优势'}
                </span>
                <p className="text-[14px] leading-relaxed text-primary">{observation.content}</p>
              </div>

              <div className="mt-2.5 flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="border-sticky-ai text-sticky-ai hover:bg-surface"
                  loading={pending}
                  disabled={disabled}
                  onClick={() => onAccept(observation.id)}
                >
                  加入
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="text-tertiary hover:bg-surface"
                  disabled={disabled}
                  onClick={() => onIgnore(observation.id)}
                >
                  忽略
                </Button>
              </div>
            </li>
          );
        })}
      </ul>

      {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
    </section>
  );
}

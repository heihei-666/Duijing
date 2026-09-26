import { Button } from '@/components/common/Button';
import type { StatusBarObservation } from '@/api/types';

interface ObservationSectionProps {
  observations: StatusBarObservation[];
  /** 正在提交的观察 id，用于禁用按钮 */
  pendingId: number | null;
  error: string | null;
  onAccept: (id: number) => void;
  onIgnore: (id: number) => void;
  /**
   * 空状态里的「记一笔」：直接在首页唤起极简事件卡，不跳资产页（Cold start 改造 · 任务 3）。
   * 不传就只显示说明文案。
   */
  onQuickRecord?: () => void;
}

/**
 * 状态栏第三块「AI 观察」：--sticky-ai-bg 冷灰蓝底，和用户内容区分（配色方案 六）。
 * 正文用暖黑保证可读性，只有标题 / 角标 / 「加入」用 AI 冷色。
 * 24 小时规则由服务端控制，前端只负责展示与处理。
 *
 * 空状态对新用户是第一屏：不写「暂时没有新的观察」这种被动告知——
 * AI 观察不是等来的，得先有素材；所以这里直接给「记一笔」。
 */
export function ObservationSection({
  observations,
  pendingId,
  error,
  onAccept,
  onIgnore,
  onQuickRecord,
}: ObservationSectionProps) {
  return (
    <section className="rounded-2xl border border-sticky-ai bg-sticky-ai px-4 py-4">
      <h2 className="text-xs text-sticky-ai">AI 观察</h2>

      {observations.length === 0 ? (
        <div className="pt-2 text-center">
          <p className="text-[14px] leading-relaxed text-primary">
            记录一个你今天不爽的瞬间，AI 帮你看看盲区。
          </p>
          {onQuickRecord ? (
            <Button variant="outline" className="mt-3" onClick={onQuickRecord}>
              记一笔
            </Button>
          ) : (
            <p className="mt-1.5 text-xs text-tertiary">辩一轮，或记几笔事件卡，观察会出现在这里。</p>
          )}
        </div>
      ) : (
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
      )}

      {error ? <p className="mt-3 text-xs text-danger">{error}</p> : null}
    </section>
  );
}

import { Button } from '@/components/common/Button';

interface EventCardHeroProps {
  /** 打开极简事件卡记录面板 */
  onRecord: () => void;
}

/**
 * 首页第一入口：**写一句话**，而不是辩一场。
 *
 * 【为什么它排在辩论前面（这是本轮最重要的一次排序调整）】
 *
 * 原来的首页第一行动是「和 AI 辩一轮」：4–8 轮对话、每轮 300 字、
 * 还要组织论点。它的门槛是「一个小时里状态最好的那 5 分钟」才够得上。
 *
 * 而「记一笔」的门槛是**一句话**。
 *
 * 留存不是靠用户每天都有力气辩论建立的，是靠「今天也来了一下」建立的。
 * 所以入口顺序必须按**门槛从低到高**排：先一句话，再一场辩论。
 *
 * 【为什么文案是问句】
 *
 * 「今天有什么让你不爽的瞬间？」比「记录事件卡」好，因为前者是
 * 一个具体到不需要思考就能回答的问题，后者是一个功能名。
 * 用户不需要知道「事件卡」是什么，他只需要知道这里可以吐槽。
 *
 * 「AI 帮你看看盲区」这句是**承诺兑现**：写下的东西会被夜间扫描，
 * 变成 AI 观察。也就是说这句话必须真的成立，否则就是在骗人。
 */
export function EventCardHero({ onRecord }: EventCardHeroProps) {
  return (
    <section className="rounded-2xl border border-light bg-surface p-6 shadow-card">
      <p className="text-[11px] tracking-wide text-tertiary">今天</p>
      <h2 className="mt-2 text-xl font-medium leading-snug text-primary">
        今天有什么让你不爽的瞬间？
      </h2>
      <p className="mt-1.5 text-[13px] leading-relaxed text-secondary">
        记一笔，AI 帮你看看盲区。
      </p>
      <Button size="lg" fullWidth className="mt-5" onClick={onRecord}>
        记一笔
      </Button>
      <p className="mt-2 text-center text-[11px] text-tertiary">
        一句话就够，不用组织
      </p>
    </section>
  );
}


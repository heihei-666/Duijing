import { Button } from '@/components/common/Button';

interface ActionSectionProps {
  onDebate: () => void;
}

/**
 * 状态栏最后一块：**只留辩论入口**。
 *
 * 【为什么「+ 记一笔」从这里被拿掉了】
 *
 * 本轮产品调整把事件卡提到了首页最上面（`EventCardHero`）：
 * 「今天有什么让你不爽的瞬间？」一行大字加一个主色按钮。
 * 如果这里再放一个「+ 记一笔」，同屏就有两个记一笔、一主一辅，
 * 反而让用户犹豫点哪个 —— 一个明确的行动比两个入口更有效。
 *
 * 于是这块只剩「和 AI 辩一轮」。它也刻意用 `subtle`（中性底）
 * 而不是主色实底：辩论是门槛最高的行动，不该和「记一笔」抢主按钮。
 */
export function ActionSection({ onDebate }: ActionSectionProps) {
  return (
    <section className="pt-1">
      <Button size="lg" variant="subtle" fullWidth onClick={onDebate}>
        和 AI 辩一轮
      </Button>
    </section>
  );
}

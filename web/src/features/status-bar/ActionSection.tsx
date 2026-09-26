import { Button } from '@/components/common/Button';

interface ActionSectionProps {
  onDebate: () => void;
  onRecord: () => void;
}

/**
 * 状态栏第四块：两个入口（方案 3.7）。
 * 「和 AI 辩一轮」是状态栏里第二个、也是最后一个彩色元素（主色实底）；
 * 「+ 记一笔」只用 --bg-elevated，保持中性。
 */
export function ActionSection({ onDebate, onRecord }: ActionSectionProps) {
  return (
    <section className="space-y-2.5">
      <Button size="lg" fullWidth onClick={onDebate}>
        和 AI 辩一轮
      </Button>
      <Button size="lg" variant="subtle" fullWidth onClick={onRecord}>
        + 记一笔
      </Button>
    </section>
  );
}

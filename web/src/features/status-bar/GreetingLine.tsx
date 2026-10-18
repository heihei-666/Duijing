interface GreetingLineProps {
  text: string;
}

/**
 * 首页的一句问候（紧贴日期下面）。
 *
 * 【为什么首页要先说话、再给数据】
 *
 * 原来的首页第一屏是：日期 + 精力 + 连续天数 + 两张空卡片。
 * 它像一个**业绩看板**，而不是一个你愿意每天打开的地方。
 *
 * 一句问候的成本极低（服务端规则生成，零 AI 调用），但它把首页的
 * 语气从「你今天的 KPI」改成「你来了」。这一点点差别，决定的是
 * 用户明天还愿不愿意点开。
 *
 * 文案由服务端产出（`app/services/status.py::get_greeting`），
 * 前端不做拼接 —— 同一句话只在一个地方定义。
 */
export function GreetingLine({ text }: GreetingLineProps) {
  if (!text) return null;
  return (
    <p className="text-[14px] leading-relaxed text-secondary" role="status">
      {text}
    </p>
  );
}

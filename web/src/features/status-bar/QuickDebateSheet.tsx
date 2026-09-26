import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiRequest } from '@/api/client';
import type { DebateCreateResponse } from '@/api/types';
import { Button } from '@/components/common/Button';
import { Sheet } from '@/components/common/Sheet';
import { getQuickTopic, pickQuickTopicIndex } from '@/features/status-bar/quickTopics';

interface QuickDebateSheetProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 即兴辩论（首页 Cold start 改造 · 任务 2）。
 *
 * 目标：一个刚注册、什么都不知道的人，点两下就能真的进到辩论房里，
 * 而不是先跳到辩论列表页对着一片空白自己摸索。
 *
 *   打开 Sheet → 看到一道预设辩题 + 两个立场按钮 → 点任一个 → 直接进辩论房
 * 题目在打开时随机取，底部「换一题」可以换（不显眼的文字按钮）。
 *
 * 请求体只发 `{ topic, stance }`（题目自带，服务端不需要再生成）：
 * `client.ts` 的 `debateApi.create` 要求 `DebateCreatePayload` 必须带 source_type，
 * 而 client.ts 本次不允许改动，所以这里用同一个文件导出的 `apiRequest`
 * ——同一套 credentials / 错误解析 / 401 跳登录，没有新增任何 fetch 逻辑。
 * 后端 `source_type` 默认就是 "manual"（app/api/debates.py），不传等价。
 */
export function QuickDebateSheet({ open, onClose }: QuickDebateSheetProps) {
  const navigate = useNavigate();

  const [topicIndex, setTopicIndex] = useState(() => pickQuickTopicIndex());
  /** 正在开局的立场文案；非 null 时禁用所有按钮 */
  const [busyStance, setBusyStance] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 每次打开都换一题并清干净上一次的状态
  useEffect(() => {
    if (!open) return;
    setTopicIndex(pickQuickTopicIndex());
    setBusyStance(null);
    setError(null);
  }, [open]);

  const current = getQuickTopic(topicIndex);
  const busy = busyStance !== null;

  async function start(stance: string) {
    setBusyStance(stance);
    setError(null);
    try {
      const data = await apiRequest<DebateCreateResponse>('/debates', {
        method: 'POST',
        body: { topic: current.topic, stance },
      });
      onClose();
      navigate(`/debates/${data.room.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没能开起来，请稍后再试');
      setBusyStance(null);
    }
  }

  return (
    <Sheet
      open={open}
      title="即兴辩论"
      onClose={() => {
        if (!busy) onClose();
      }}
      footer={
        <div className="text-center">
          <button
            type="button"
            disabled={busy}
            onClick={() => setTopicIndex((index) => pickQuickTopicIndex(index))}
            className="h-11 rounded-lg px-4 text-[13px] text-tertiary transition-colors hover:bg-elevated disabled:opacity-50"
          >
            换一题
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        <p className="text-[13px] leading-relaxed text-secondary">
          不用准备，选一边就能开始。中途可以直接放弃这一轮，不影响别的。
        </p>

        <div className="rounded-2xl bg-elevated px-4 py-5 text-center">
          <p className="text-[11px] text-tertiary">这一题</p>
          <p className="mt-1.5 text-[16px] font-medium leading-relaxed text-primary">
            {current.topic}
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-[13px] text-secondary">你站哪边？</p>
          {current.stances.map((stance) => (
            <Button
              key={stance}
              variant="outline"
              size="lg"
              fullWidth
              loading={busyStance === stance}
              disabled={busy}
              onClick={() => void start(stance)}
            >
              {stance}
            </Button>
          ))}
        </div>

        {error ? <p className="text-xs text-danger">{error}</p> : null}
      </div>
    </Sheet>
  );
}

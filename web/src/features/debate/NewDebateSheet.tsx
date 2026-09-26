import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import type { DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { Sheet } from '@/components/common/Sheet';
import { cn } from '@/lib/cn';
import { formatTimestamp } from '@/lib/date';
import { rateColor, rateHint, rateText } from '@/lib/rateColor';

import {
  countChars,
  createDebateFromSource,
  listDebateEventCards,
  listDebateLoopOptions,
  payloadFromSource,
  type DebateEventCardOption,
  type DebateLoopOption,
  type DebateSourceRef,
} from './api';

/**
 * 后端 `topic` / `stance` 的 max_length 都是 200（app/api/debates.py）。
 * 场景框也沿用 200（后端 `scene` 实际上是 500，这里保持原有输入上限不变）。
 */
const TOPIC_MAX_CHARS = 200;
const STANCE_MAX_CHARS = 200;

/** 事件卡只列最近 10 条：够挑，且不会把「刚发生的事」变成翻历史 */
const RECENT_CARD_LIMIT = 10;

type SourceMode = 'manual' | 'scene' | 'loop' | 'event';

interface SourceOptions {
  loops: DebateLoopOption[];
  cards: DebateEventCardOption[];
}

interface ModeMeta {
  key: SourceMode;
  label: string;
  hint: string;
}

const MANUAL_MODE: ModeMeta = {
  key: 'manual',
  label: '自己出题',
  hint: '直接写辩题和你的立场。',
};
const SCENE_MODE: ModeMeta = {
  key: 'scene',
  label: '描述场景',
  hint: '写清情境，AI 据此出题开场。',
};
const LOOP_MODE: ModeMeta = {
  key: 'loop',
  label: '从回环起辩',
  hint: '选一条正在练的回环，点一下就开，不用写题目。',
};
const EVENT_MODE: ModeMeta = {
  key: 'event',
  label: '刚发生的事',
  hint: '选一件刚记下的事，点一下就开，不用写题目。',
};

interface NewDebateSheetProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功：把房间交回页面去跳转 */
  onCreated: (room: DebateRoom) => void;
}

/**
 * 新建辩论（契约 3 章 POST /api/debates）——四个辩题来源（方案 3.1 的 P0/P1/P2）：
 *
 *   P1 从回环起辩   `{ source_type:'weakness', loop_id }` → 后端用回环的触发场景 /
 *                   身体信号 / 预案拼出场景交给 AI 出题，并让 AI 在辩论里制造该场景。
 *                   用户只需要点一条，一个字的输入都不需要。
 *   P2 刚发生的事   `{ source_type:'event_card', source_id }` → 用事件卡内容当场景。
 *                   同样一键发起。
 *   P0 描述场景     `{ scene }` → AI 转成辩题（`_scene_from_source` 的第一优先级）。
 *   P0 自己出题     `{ topic, stance }` → 直接开，不经 AI 出题。
 *
 * 为什么「描述场景」现在发 `scene` 而不是把场景塞进 `topic`：
 *   早先的注释假设「后端只有带 loop_id/weakness_id 上下文时才会用上下文造场景」，
 *   但 `_scene_from_source` 第一句就是 `if payload.scene.strip(): return ...`，
 *   与上下文无关。所以这个来源可以按契约发 `scene`、把 `topic` 留空，
 *   由 AI 生成辩题——这正是「描述场景」这个模式名承诺的事。
 *
 * 为什么回环 / 事件卡列表在打开时才拉：这两个列表决定了要不要显示对应的分段
 *   （没有在练的回环就不显示「从回环起辩」），所以一打开就得知道有没有。
 *   两个请求都用 allSettled，一个挂了不影响另一个，也不会把整块面板变成错误页。
 */
export function NewDebateSheet({ open, onClose, onCreated }: NewDebateSheetProps) {
  const navigate = useNavigate();

  /** null = 用户还没选过来源，此时按「有没有回环」给默认值 */
  const [mode, setMode] = useState<SourceMode | null>(null);
  const [topic, setTopic] = useState('');
  const [stance, setStance] = useState('');
  const [scene, setScene] = useState('');

  /** null = 正在拉取候选 */
  const [options, setOptions] = useState<SourceOptions | null>(null);
  const [optionsError, setOptionsError] = useState<string | null>(null);

  const [submitting, setSubmitting] = useState(false);
  /** 正在一键发起的那一条（'loop-3' / 'card-12'），非 null 时锁住全部入口 */
  const [startingKey, setStartingKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  /** 关掉再打开时可能有两个请求在飞，只认最后一次 */
  const loadSeq = useRef(0);

  const loadOptions = useCallback(async () => {
    const seq = (loadSeq.current += 1);
    setOptions(null);
    setOptionsError(null);

    const [loops, cards] = await Promise.allSettled([
      listDebateLoopOptions(),
      listDebateEventCards(RECENT_CARD_LIMIT),
    ]);
    if (loadSeq.current !== seq) return;

    setOptions({
      loops: loops.status === 'fulfilled' ? (loops.value.loops ?? []) : [],
      cards: cards.status === 'fulfilled' ? (cards.value.cards ?? []) : [],
    });

    const failed = [loops, cards].filter((item) => item.status === 'rejected').length;
    if (failed === 2) {
      setOptionsError('回环和事件卡都没能读出来，可以先自己出题或描述场景。');
    } else if (loops.status === 'rejected') {
      setOptionsError('回环列表没能读出来，可以先自己出题或描述场景。');
    } else if (cards.status === 'rejected') {
      setOptionsError('事件卡没能读出来，可以先自己出题或描述场景。');
    }
  }, []);

  // 每次打开都重置并把候选重新拉一次：回环刚建好、事件卡刚记下的情况很常见
  useEffect(() => {
    if (!open) return;
    setMode(null);
    setTopic('');
    setStance('');
    setScene('');
    setError(null);
    setStartingKey(null);
    setSubmitting(false);
    void loadOptions();
  }, [open, loadOptions]);

  const loops = options?.loops ?? [];
  const cards = options?.cards ?? [];

  // 没有任何回环就不出现「从回环起辩」，没有任何事件卡就不出现「刚发生的事」
  const segments: ModeMeta[] = [
    ...(loops.length > 0 ? [LOOP_MODE] : []),
    ...(cards.length > 0 ? [EVENT_MODE] : []),
    SCENE_MODE,
    MANUAL_MODE,
  ];
  const activeMode: SourceMode = mode ?? (loops.length > 0 ? 'loop' : 'manual');
  const active = segments.find((item) => item.key === activeMode) ?? MANUAL_MODE;

  const busy = submitting || startingKey !== null;
  const oneClick = activeMode === 'loop' || activeMode === 'event';

  const reset = () => {
    setMode(null);
    setTopic('');
    setStance('');
    setScene('');
    setError(null);
  };

  const handleClose = () => {
    if (busy) return;
    reset();
    onClose();
  };

  /** 一键起辩：点一条回环 / 一张事件卡就开，不做二次确认 */
  async function startFrom(source: DebateSourceRef, key: string) {
    if (busy) return;
    setStartingKey(key);
    setError(null);
    try {
      const { room } = await createDebateFromSource(payloadFromSource(source));
      reset();
      onCreated(room);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '没能开起来，请稍后再试');
    } finally {
      setStartingKey(null);
    }
  }

  const handleSubmit = async () => {
    const manualTopic = topic.trim();
    const sceneText = scene.trim();
    const stanceText = stance.trim();

    if (activeMode === 'manual' && manualTopic === '') {
      setError('先写下辩题。');
      return;
    }
    if (activeMode === 'manual' && stanceText === '') {
      setError('再写下你的立场：这一场你站哪一边。');
      return;
    }
    if (activeMode === 'scene' && sceneText === '') {
      setError('先描述一个场景，例如「开会被追问进度」。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { room } = await createDebateFromSource(
        activeMode === 'manual'
          ? { topic: manualTopic, stance: stanceText, source_type: 'manual' }
          : // 只发 scene，topic 留空让 AI 出题；立场可留空，后端会补生成的立场
            { scene: sceneText, stance: stanceText, source_type: 'manual' },
      );
      reset();
      onCreated(room);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  /** 空列表时的引导：不做成第二个主按钮，给一条能走的路径就够 */
  const goWeaknesses = () => {
    if (busy) return;
    reset();
    onClose();
    navigate('/weaknesses');
  };

  return (
    <Sheet
      open={open}
      title="开一场新的辩论"
      onClose={handleClose}
      footer={
        oneClick ? (
          <Button variant="outline" fullWidth disabled={busy} onClick={handleClose}>
            取消
          </Button>
        ) : (
          <div className="flex gap-3">
            <Button variant="outline" fullWidth disabled={submitting} onClick={handleClose}>
              取消
            </Button>
            <Button fullWidth loading={submitting} onClick={() => void handleSubmit()}>
              开始
            </Button>
          </div>
        )
      }
    >
      <div className="max-h-[58vh] space-y-4 overflow-y-auto">
        <div
          role="tablist"
          aria-label="辩题来源"
          className="grid grid-cols-2 gap-1 rounded-xl border border-light bg-elevated p-1"
        >
          {segments.map((item) => (
            <button
              key={item.key}
              type="button"
              role="tab"
              aria-selected={item.key === activeMode}
              disabled={busy}
              onClick={() => {
                setMode(item.key);
                setError(null);
              }}
              className={cn(
                'h-11 rounded-lg px-2 text-[13px] transition-colors disabled:opacity-50',
                item.key === activeMode
                  ? 'bg-surface font-medium text-primary shadow-card'
                  : 'text-secondary',
              )}
            >
              <span className="block truncate">{item.label}</span>
            </button>
          ))}
        </div>

        <p className="text-xs leading-relaxed text-tertiary">{active.hint}</p>

        {options === null ? (
          <p className="text-center text-xs text-tertiary">正在读取…</p>
        ) : null}

        {activeMode === 'manual' ? (
          <Field
            label="辩题"
            value={topic}
            maxLength={TOPIC_MAX_CHARS}
            placeholder="例如：该不该在会议上直接反驳领导"
            hint={`${countChars(topic)} / ${TOPIC_MAX_CHARS}`}
            onChange={(event) => setTopic(event.target.value)}
            // 候选还在飞的时候用户已经动手打字了，就不要再自动切到回环列表
            onFocus={() => setMode('manual')}
          />
        ) : null}

        {activeMode === 'scene' ? (
          <div className="space-y-1.5">
            <label htmlFor="debate-scene" className="block text-[13px] text-secondary">
              场景描述
            </label>
            <textarea
              id="debate-scene"
              value={scene}
              maxLength={TOPIC_MAX_CHARS}
              rows={3}
              placeholder="例如：周会上领导追问进度，我手上还没结论"
              onChange={(event) => setScene(event.target.value)}
              onFocus={() => setMode('scene')}
              className={cn(
                'min-h-[88px] w-full resize-none rounded-xl border border-light bg-surface px-3 py-2.5',
                'text-[15px] leading-relaxed text-primary placeholder:text-disabled',
                'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary',
              )}
            />
            <p className="text-xs text-tertiary">
              {countChars(scene)} / {TOPIC_MAX_CHARS}
            </p>
          </div>
        ) : null}

        {activeMode === 'loop' ? (
          <ul className="space-y-2">
            {loops.map((loop) => {
              const key = `loop-${loop.id}`;
              return (
                <li key={loop.id}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-busy={startingKey === key}
                    onClick={() => void startFrom({ kind: 'loop', loopId: loop.id }, key)}
                    className={cn(
                      'flex min-h-[44px] w-full items-start gap-3 rounded-xl border border-light bg-surface px-3.5 py-3 text-left',
                      'transition-colors hover:bg-elevated disabled:opacity-50',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-[14px] leading-snug text-primary">
                        {loop.trigger_scene}
                      </span>
                      {loop.weakness_name ? (
                        <span className="mt-1 block truncate text-[11px] text-tertiary">
                          {loop.weakness_name}
                        </span>
                      ) : null}
                    </span>
                    <span className="shrink-0 text-right">
                      <span className="block text-[11px] text-tertiary">撑住率</span>
                      <span
                        className="block text-[13px] font-medium tabular-nums"
                        style={{ color: rateColor(loop.hold_rate_30d) }}
                        title={rateHint(loop.hold_rate_30d)}
                      >
                        {/* 还没有触发记录（null）显示 --，不能画成 0% */}
                        {rateText(loop.hold_rate_30d)}
                      </span>
                    </span>
                    {startingKey === key ? <RowSpinner /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {activeMode === 'event' ? (
          <ul className="space-y-2">
            {cards.map((card) => {
              const key = `card-${card.id}`;
              return (
                <li key={card.id}>
                  <button
                    type="button"
                    disabled={busy}
                    aria-busy={startingKey === key}
                    onClick={() => void startFrom({ kind: 'event_card', cardId: card.id }, key)}
                    className={cn(
                      'flex min-h-[44px] w-full items-start gap-3 rounded-xl border border-light bg-surface px-3.5 py-3 text-left',
                      'transition-colors hover:bg-elevated disabled:opacity-50',
                    )}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 block text-[14px] leading-relaxed text-primary">
                        {card.content}
                      </span>
                      <span className="mt-1 block text-[11px] text-tertiary">
                        {formatTimestamp(card.created_at)}
                      </span>
                    </span>
                    {startingKey === key ? <RowSpinner /> : null}
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}

        {activeMode === 'manual' || activeMode === 'scene' ? (
          <Field
            label={activeMode === 'manual' ? '我的立场' : '我的立场（可留空）'}
            value={stance}
            maxLength={STANCE_MAX_CHARS}
            placeholder="例如：应该直接反驳，但先确认事实"
            hint={`${countChars(stance)} / ${STANCE_MAX_CHARS}`}
            onChange={(event) => setStance(event.target.value)}
            // 同上：动手打字就把来源钉在当前的输入型来源上
            onFocus={() => setMode(activeMode)}
          />
        ) : null}

        {options !== null && loops.length === 0 && !oneClick ? (
          <div className="flex items-center gap-2">
            <p className="min-w-0 flex-1 text-xs leading-relaxed text-tertiary">
              还没有在练的回环，先在弱点墙建一条。
            </p>
            <button
              type="button"
              onClick={goWeaknesses}
              className="h-11 shrink-0 rounded-lg px-2 text-[13px] text-brand transition-colors hover:bg-elevated"
            >
              去弱点墙
            </button>
          </div>
        ) : null}

        {optionsError ? (
          <p className="text-xs leading-relaxed text-tertiary">{optionsError}</p>
        ) : null}

        {error ? <p className="text-xs leading-relaxed text-danger">{error}</p> : null}

        <p className="text-xs leading-relaxed text-tertiary">
          回合数由 AI 按辩题复杂度决定，落在 4–8 轮；每轮发言不超过 300 字。
        </p>
      </div>
    </Sheet>
  );
}

/** 列表行上的加载指示，和 Button 里的转圈同一套写法 */
function RowSpinner() {
  return (
    <span
      aria-hidden
      className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-current border-t-transparent text-tertiary"
    />
  );
}

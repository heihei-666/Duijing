import { useState } from 'react';

import type { DebateRoom } from '@/api/types';
import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { Sheet } from '@/components/common/Sheet';
import { cn } from '@/lib/cn';

import { countChars, createDebate } from './api';

/** 后端 `topic` / `stance` 的 max_length 都是 200（app/api/debates.py） */
const TOPIC_MAX_CHARS = 200;
const STANCE_MAX_CHARS = 200;

type SourceMode = 'manual' | 'scene';

interface NewDebateSheetProps {
  open: boolean;
  onClose: () => void;
  /** 创建成功：把房间交回页面去跳转 */
  onCreated: (room: DebateRoom) => void;
}

const MODES: Array<{ key: SourceMode; label: string; hint: string }> = [
  { key: 'manual', label: '自己出题', hint: '直接写辩题和你的立场。' },
  { key: 'scene', label: '描述场景', hint: '写清情境，系统据此开场。' },
];

/**
 * 新建辩论（契约 3 章 POST /api/debates）。
 *
 * 两种来源都落在 `source_type: 'manual'`（方案 3.1 的 P0：用户自己出题）。
 *
 * 「描述场景」为什么把场景写进 `topic`：
 *   契约写的是「topic 可空：传 source_* 时由 AI 生成」，但后端实现里
 *   只有带 loop_id / weakness_id 上下文时才会用上下文造场景，否则空 topic 直接返回
 *   400「请提供辩题或场景描述」。本模块不接弱点库（那是并行同事的范围），
 *   所以场景文本只能经 `topic` 提交，由 AI 在第一轮开场里接住。
 */
export function NewDebateSheet({ open, onClose, onCreated }: NewDebateSheetProps) {
  const [mode, setMode] = useState<SourceMode>('manual');
  const [topic, setTopic] = useState('');
  const [stance, setStance] = useState('');
  const [scene, setScene] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setMode('manual');
    setTopic('');
    setStance('');
    setScene('');
    setError(null);
  };

  const handleClose = () => {
    if (submitting) return;
    reset();
    onClose();
  };

  const handleSubmit = async () => {
    const manualTopic = topic.trim();
    const sceneText = scene.trim();
    const stanceText = stance.trim();

    if (mode === 'manual' && manualTopic === '') {
      setError('先写下辩题。');
      return;
    }
    if (mode === 'scene' && sceneText === '') {
      setError('先描述一个场景，例如「开会被追问进度」。');
      return;
    }
    if (mode === 'manual' && stanceText === '') {
      setError('再写下你的立场：这一场你站哪一边。');
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const { room } = await createDebate({
        topic: mode === 'manual' ? manualTopic : sceneText,
        stance: stanceText,
        source_type: 'manual',
        source_id: null,
        loop_id: null,
      });
      reset();
      onCreated(room);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '创建失败，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  const active = MODES.find((item) => item.key === mode) ?? MODES[0];

  return (
    <Sheet
      open={open}
      title="开一场新的辩论"
      onClose={handleClose}
      footer={
        <div className="flex gap-3">
          <Button variant="outline" fullWidth disabled={submitting} onClick={handleClose}>
            取消
          </Button>
          <Button fullWidth loading={submitting} onClick={() => void handleSubmit()}>
            开始
          </Button>
        </div>
      }
    >
      <div className="max-h-[58vh] space-y-4 overflow-y-auto">
        <div className="flex rounded-xl border border-light bg-elevated p-1">
          {MODES.map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => {
                setMode(item.key);
                setError(null);
              }}
              className={cn(
                'h-11 flex-1 rounded-lg text-[14px] transition-colors',
                item.key === mode
                  ? 'bg-surface font-medium text-primary shadow-card'
                  : 'text-secondary',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        <p className="text-xs leading-relaxed text-tertiary">{active.hint}</p>

        {mode === 'manual' ? (
          <Field
            label="辩题"
            value={topic}
            maxLength={TOPIC_MAX_CHARS}
            placeholder="例如：该不该在会议上直接反驳领导"
            hint={`${countChars(topic)} / ${TOPIC_MAX_CHARS}`}
            onChange={(event) => setTopic(event.target.value)}
          />
        ) : (
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
        )}

        <Field
          label={mode === 'manual' ? '我的立场' : '我的立场（可留空）'}
          value={stance}
          maxLength={STANCE_MAX_CHARS}
          placeholder="例如：应该直接反驳，但先确认事实"
          hint={`${countChars(stance)} / ${STANCE_MAX_CHARS}`}
          onChange={(event) => setStance(event.target.value)}
        />

        {error ? <p className="text-xs leading-relaxed text-danger">{error}</p> : null}

        <p className="text-xs leading-relaxed text-tertiary">
          回合数由 AI 按辩题复杂度决定，落在 4–8 轮；每轮发言不超过 300 字。
        </p>
      </div>
    </Sheet>
  );
}

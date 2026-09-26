import { useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/cn';
import { Button } from '@/components/common/Button';
import { Field } from '@/components/common/Field';
import { Sheet } from '@/components/common/Sheet';
import {
  EMPTY_LOOP_ASSETS,
  LoopAssetPicker,
  type LoopAssetSelection,
} from '@/features/assets/LoopAssetPicker';
import { createLoop, updateLoop, type LoopData } from '@/features/weakness/api';
import { TextAreaField } from '@/features/weakness/TextAreaField';

type Mode = 'dialog' | 'form';

/**
 * 对话式三步 + 确认步（方案 3.3）：
 *   scene  → 服务端回 { step:'signal', question, trigger_scene }
 *   signal → 服务端回 { step:'plan',   question, trigger_scene, body_signal }
 *   plan   → 服务端回 { step:'confirm', loop, confirm_question }（API.md 只写了后两个字段）
 *   confirm→ 用户点「现在启用」才 PATCH status=active；否则留在 draft
 */
type DialogStage = 'scene' | 'signal' | 'plan' | 'confirm';

interface Bubble {
  id: number;
  role: 'ai' | 'user';
  text: string;
}

interface LoopCreateSheetProps {
  weaknessId: number;
  weaknessName: string;
  onClose: () => void;
  /** 结束（启用 / 存草稿）后由详情页刷新并给一句反馈 */
  onFinished: (message: string) => void;
}

const STAGE_PLACEHOLDER: Record<Exclude<DialogStage, 'confirm'>, string> = {
  scene: '例如：开会被追问进度时',
  signal: '例如：心跳加快，想马上反驳',
  plan: '例如：先说「这点我还没想清楚」，再补事实',
};

const STAGE_LABEL: Record<Exclude<DialogStage, 'confirm'>, string> = {
  scene: '当时发生了什么',
  signal: '身体 / 情绪信号',
  plan: '下次准备怎么做',
};

export function LoopCreateSheet({
  weaknessId,
  weaknessName,
  onClose,
  onFinished,
}: LoopCreateSheetProps) {
  const [mode, setMode] = useState<Mode>('dialog');

  // —— 对话式 ——
  const bubbleId = useRef(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const [stage, setStage] = useState<DialogStage>('scene');
  const [bubbles, setBubbles] = useState<Bubble[]>([
    { id: 0, role: 'ai', text: `先说说最近一次「${weaknessName}」出现的场景吧。` },
  ]);
  const [input, setInput] = useState('');
  const [triggerScene, setTriggerScene] = useState('');
  const [bodySignal, setBodySignal] = useState('');
  const [createdLoop, setCreatedLoop] = useState<LoopData | null>(null);
  const [pending, setPending] = useState(false);
  const [dialogError, setDialogError] = useState<string | null>(null);

  // —— 表单 ——
  const [formScene, setFormScene] = useState('');
  const [formSignal, setFormSignal] = useState('');
  const [formPlan, setFormPlan] = useState('');
  const [formActivate, setFormActivate] = useState(true);
  /** 预案里引用的优势 / 原则（方案 3.3）。对话式三步不收集，只有表单 tab 用 */
  const [formAssets, setFormAssets] = useState<LoopAssetSelection>(EMPTY_LOOP_ASSETS);
  const [formPending, setFormPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // 新消息进来后滚到底部（对话式最容易漏的一步）
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [bubbles, pending]);

  function pushBubble(role: Bubble['role'], text: string) {
    bubbleId.current += 1;
    const id = bubbleId.current;
    setBubbles((current) => [...current, { id, role, text }]);
  }

  async function sendDialog() {
    const content = input.trim();
    if (!content || pending || stage === 'confirm') return;

    pushBubble('user', content);
    setInput('');
    setPending(true);
    setDialogError(null);

    try {
      const response = await createLoop(weaknessId, {
        mode: 'dialog',
        step: stage,
        content,
        ...(stage === 'scene' ? {} : { trigger_scene: triggerScene }),
        ...(stage === 'plan' ? { body_signal: bodySignal } : {}),
      });

      // 第三步：拿到草稿回环 + 确认问句（服务端 step='confirm'，API.md 只保证这两个字段）
      if (response.loop) {
        const question = response.confirm_question ?? '好，这就是你的预案。要现在启用吗？';
        setCreatedLoop(response.loop);
        pushBubble('ai', question);
        setStage('confirm');
        return;
      }

      if (response.step === 'signal') {
        setTriggerScene(response.trigger_scene ?? content);
        pushBubble('ai', response.question ?? '当时身体有什么感觉？');
        setStage('signal');
        return;
      }

      if (response.step === 'plan') {
        if (response.trigger_scene) setTriggerScene(response.trigger_scene);
        setBodySignal(response.body_signal ?? content);
        pushBubble('ai', response.question ?? '下次遇到类似情况，你想怎么做？');
        setStage('plan');
        return;
      }

      setDialogError('服务端返回的步骤和预期不一致，请重试一次。');
    } catch (cause) {
      // 失败时把用户那句话留在气泡里，方便直接重发
      setDialogError(cause instanceof Error ? cause.message : '发送失败，请稍后再试');
    } finally {
      setPending(false);
    }
  }

  async function enableLoop() {
    if (!createdLoop) return;
    setPending(true);
    setDialogError(null);
    try {
      await updateLoop(createdLoop.id, { status: 'active' });
      onFinished('回环已启用，去弱点详情里记录演练吧');
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : '启用失败，请稍后再试');
      setPending(false);
    }
  }

  async function submitForm() {
    const scene = formScene.trim();
    if (!scene) {
      setFormError('触发场景不能为空');
      return;
    }

    setFormPending(true);
    setFormError(null);
    try {
      await createLoop(weaknessId, {
        mode: 'form',
        trigger_scene: scene,
        body_signal: formSignal.trim(),
        action_plan: formPlan.trim(),
        activate: formActivate,
        // 没选就是空数组，和后端 default_factory=list 等价
        linked_advantage_ids: formAssets.advantageIds,
        linked_principle_ids: formAssets.principleIds,
      });
      onFinished(formActivate ? '回环已启用' : '已存为草稿');
    } catch (cause) {
      setFormError(cause instanceof Error ? cause.message : '保存失败，请稍后再试');
      setFormPending(false);
    }
  }

  return (
    <Sheet open title="新建回环" onClose={onClose}>
      <div className="max-h-[64vh] space-y-4 overflow-y-auto pb-4">
        <div className="flex gap-1 rounded-xl bg-elevated p-1">
          {(
            [
              { key: 'dialog', label: '对话式' },
              { key: 'form', label: '表单' },
            ] as Array<{ key: Mode; label: string }>
          ).map((item) => (
            <button
              key={item.key}
              type="button"
              aria-pressed={mode === item.key}
              onClick={() => setMode(item.key)}
              className={cn(
                'h-11 flex-1 rounded-lg text-[13px] transition-colors',
                mode === item.key
                  ? 'bg-surface text-primary shadow-card'
                  : 'text-secondary hover:text-primary',
              )}
            >
              {item.label}
            </button>
          ))}
        </div>

        {mode === 'dialog' ? (
          <>
            <div ref={listRef} className="max-h-[38vh] space-y-2.5 overflow-y-auto pr-1">
              {bubbles.map((bubble) =>
                bubble.role === 'ai' ? (
                  <div key={bubble.id} className="flex">
                    <p className="max-w-[85%] rounded-2xl rounded-tl-md border border-light bg-surface px-3.5 py-2 text-[14px] leading-relaxed text-primary">
                      {bubble.text}
                    </p>
                  </div>
                ) : (
                  <div key={bubble.id} className="flex justify-end">
                    <p className="max-w-[85%] rounded-2xl rounded-tr-md bg-primary px-3.5 py-2 text-[14px] leading-relaxed text-on-brand">
                      {bubble.text}
                    </p>
                  </div>
                ),
              )}
            </div>

            {stage === 'confirm' ? (
              <div className="space-y-2">
                <div className="flex gap-2">
                  <Button
                    className="flex-1"
                    loading={pending}
                    disabled={pending}
                    onClick={() => void enableLoop()}
                  >
                    现在启用
                  </Button>
                  <Button
                    variant="outline"
                    className="flex-1"
                    disabled={pending}
                    onClick={() => onFinished('已存为草稿，随时可以启用')}
                  >
                    先留着
                  </Button>
                </div>
                <p className="text-xs text-tertiary">
                  草稿不会出现在「今天练什么」里，需要手动启用。
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                <TextAreaField
                  label={STAGE_LABEL[stage]}
                  placeholder={STAGE_PLACEHOLDER[stage]}
                  rows={2}
                  maxLength={2000}
                  value={input}
                  disabled={pending}
                  onChange={(event) => setInput(event.target.value)}
                />
                <Button
                  fullWidth
                  loading={pending}
                  disabled={pending || input.trim() === ''}
                  onClick={() => void sendDialog()}
                >
                  发送
                </Button>
              </div>
            )}

            {dialogError ? <p className="text-xs text-danger">{dialogError}</p> : null}
          </>
        ) : (
          <div className="space-y-4">
            <Field
              label="触发场景"
              placeholder="什么情况下会犯这个弱点？"
              maxLength={2000}
              value={formScene}
              onChange={(event) => setFormScene(event.target.value)}
            />
            <Field
              label="身体 / 情绪信号"
              placeholder="例如：心跳加快，想马上反驳"
              maxLength={2000}
              value={formSignal}
              onChange={(event) => setFormSignal(event.target.value)}
            />
            <TextAreaField
              label="应对预案"
              placeholder="下次遇到时，具体做什么？"
              rows={3}
              maxLength={2000}
              value={formPlan}
              onChange={(event) => setFormPlan(event.target.value)}
            />

            {/* 方案 3.3：预案可从优势库、原则库引用（只列已确认的优势 / 已启用的原则） */}
            <LoopAssetPicker
              value={formAssets}
              onChange={setFormAssets}
              disabled={formPending}
            />

            <label className="flex min-h-[44px] items-center gap-2 text-[13px] text-secondary">
              <input
                type="checkbox"
                className="h-4 w-4"
                style={{ accentColor: 'var(--primary)' }}
                checked={formActivate}
                onChange={(event) => setFormActivate(event.target.checked)}
              />
              建好后直接启用
            </label>

            <Button
              fullWidth
              loading={formPending}
              disabled={formPending}
              onClick={() => void submitForm()}
            >
              保存回环
            </Button>

            {formError ? <p className="text-xs text-danger">{formError}</p> : null}
          </div>
        )}
      </div>
    </Sheet>
  );
}

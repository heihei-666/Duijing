import { useNavigate } from 'react-router-dom';

import { Sheet } from '@/components/common/Sheet';
import { Button } from '@/components/common/Button';
import { useOnboardingStore } from '@/store/onboarding';

/**
 * 「这个入口还没解锁」弹层（新用户防挫败）。
 *
 * 【为什么不是直接把 tab 置灰不可点】
 *
 * 置灰的 tab 会让人以为「这个功能坏了」或者「我不配用」，而且点下去没有任何反馈
 * —— 那是更深的挫败。现在这一版：图标上挂一把小锁（预告有东西在里面），
 * 点下去给一句**说明 + 一条出路**，然后把他送回首页的两个核心动作。
 *
 * 【为什么不写「暂未开放」】
 *
 * 「暂未开放」是在推诿，它只说了「不行」。这里的文案要同时回答两个问题：
 *   · 为什么现在没有 —— 还没有素材，AI 没有可观察的东西
 *   · 怎么才能有 —— 记一笔，或者辩一场
 * 所以主按钮直接把人送回首页，而不是留他在这里干瞪眼。
 */
export function LockedFeatureSheet() {
  const navigate = useNavigate();
  const label = useOnboardingStore((s) => s.lockedLabel);
  const closeLock = useOnboardingStore((s) => s.closeLock);

  return (
    <Sheet
      open={label !== null}
      title={label ? `「${label}」还是空的` : ''}
      onClose={closeLock}
      footer={
        <div className="flex gap-3">
          <Button variant="outline" fullWidth onClick={closeLock}>
            知道了
          </Button>
          <Button
            fullWidth
            onClick={() => {
              closeLock();
              navigate('/');
            }}
          >
            去记一笔
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-[15px] leading-relaxed text-primary">
          记录 / 辩论后解锁你的专属画像。
        </p>
        <p className="text-[13px] leading-relaxed text-secondary">
          这里放的是 AI 从你的记录里看出来的模式。现在还没有素材 ——
          先记一笔让你不爽的瞬间，或者辩一场，它才会长出来。
        </p>
      </div>
    </Sheet>
  );
}

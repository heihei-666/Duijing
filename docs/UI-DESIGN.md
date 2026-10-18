# 前端视觉规范与主题系统

> 这份文档记录的是**这个仓库特有的**前端约定和踩过的坑，不是通用设计指南。
> 通用产品设计见 `配色方案.txt` / `方案对照表.md`；这里只讲「改代码时必须知道的事」。

---

## 一、颜色：只走令牌，不写色值

所有颜色定义在 `web/src/styles/tokens.css`，`web/tailwind.config.js` 只做
「类名 → `var(--x)`」的映射。**组件里任何地方都不要出现十六进制色值。**

```tsx
✅ className="bg-surface text-primary border-light"
❌ className="bg-[#FFFFFF] text-[#2C2A26]"
```

理由：暗色主题是**整套变量替换**（见下），写死色值的地方在暗色下必然翻不掉。

### 令牌分哪几类

| 类别 | 令牌 | 用在哪 |
|---|---|---|
| 中性 | `--bg-base/surface/elevated/inset`、`--border-light/strong`、`--text-primary/secondary/tertiary/disabled` | 页面底、卡片、输入框、正文 |
| 主色 | `--primary`、`--primary-hover`、`--primary-light`、`--primary-text` | 主按钮、链接、强调 |
| 功能 | `--success/warning/danger/info` + 各自的 `-light` | 状态、便签描边 |
| 便签 | `--sticky-ai/observing/improving/archived-*` | 弱点便签四态 |
| 撑住率 | `--rate-low/mid/good/great` | 进度条；也用于精力电池分档 |
| 阴影 | `--shadow-card`、`-card-hover`、`-sheet`、`-modal` | 卡片 / 弹层 |

---

## 二、暗色主题怎么做

**结论：用 CSS 变量翻，不要用 Tailwind 的 `dark:` 变体。**

- 换肤 = 在 `<html>` 上改 `data-theme="light" | "dark"`
- `tokens.css` 里的 `[data-theme='dark']` 块覆盖同名变量
- **一个组件都不用改**

如果用 `dark:` 变体，要在几十个组件里补一遍类名，必然漏几个 —— 而漏掉的地方
在暗色下就是一块刺眼的白。

### 新增一个颜色令牌时必须做三件事

1. `tokens.css` 的 `:root` 里加亮色值
2. `tokens.css` 的 `[data-theme='dark']` 里加暗色值（**不能省**，否则暗色下
   这个变量不存在，`var()` 会静默回退成空值）
3. `tailwind.config.js` 的 `colors` / `backgroundColor` / `textColor` 里映射类名

### 暗色的两个特殊处理

- **主色反过来**：暗底上 `--primary` 是浅蓝、`--primary-text` 是深色。
  深蓝底 + 白字在暗色主题里对比度不够。
- **阴影必须更黑更大**：亮色是 `rgba(44,42,38,.045)`，暗色是 `rgba(0,0,0,.35)`。
  照搬亮色阴影在暗底上等于看不见。

主题状态在 `web/src/store/theme.ts`：
首次访问跟随系统 `prefers-color-scheme`，手动切过之后记在 `localStorage('dj:theme')`，
并同步 `<meta name="theme-color">`。

---

## 三、⚠️ 最大的坑：Tailwind 类名**静默失效**

> 这个坑在本仓库已经踩了两次，两次都靠看截图才发现。

### 现象

```tsx
<span className="bg-brand" />   // 元素有宽高，但没有背景色 —— 完全透明
```

`brand` 只定义在 `tailwind.config.js` 的 `textColor` 里，
`backgroundColor` / `colors` 里**没有它**。于是这个类名不生成任何 CSS。

### 为什么三关都拦不住

| 关卡 | 为什么漏 |
|---|---|
| `tsc` | 类名是字符串，类型系统管不着 |
| Tailwind | 不存在的类名**不报错、不警告**，直接当没写 |
| 整页截图 | 小控件（28px 宽）肉眼看不出「没颜色」和「颜色很淡」 |

### 已经踩过的两次

1. **精力电池条没有填充** —— 填充元素写了 `bg-brand`，电池看起来是空的
2. **原则库列表圆点不显示** —— 同样是 `bg-brand`，圆点是透明的

### 怎么防

- 写 `bg-*` 前先确认 `backgroundColor` 段里有这个键（`text-*` 有 ≠ `bg-*` 有）
- 数值相关的东西**量出来**：`getComputedStyle(el).backgroundColor` /
  `el.getBoundingClientRect().width`，不要靠看截图
- 系统性防线（**待做**）：写一个脚本把全站 `bg-*/text-*/border-*` 类名扫出来，
  和 `tailwind.config.js` 里实际存在的键交叉校验，挂进 CI 的前端作业

---

## 四、卡片规范

标准卡片（首页事件卡 / 今天练什么 / 过去的你 / AI 观察 / 列表项）：

```
rounded-2xl border border-light bg-surface p-5 shadow-card
```

| 属性 | 值 | 说明 |
|---|---|---|
| 圆角 | `rounded-2xl`（16px） | 列表里的小条目用 `rounded-xl` |
| 描边 | `border-light` | 就是 `#E5E2DB`，暗色自动换成深色 |
| 内边距 | `p-5` 起，主卡片 `p-6` | 4 单位太挤，文字贴边 |
| 阴影 | `shadow-card` | 几乎察觉不到，但拿掉页面立刻变平 |

**阴影是三层叠加**：小半径给「贴桌面」的实感，大半径给「浮起来」的空气感。
单层阴影要么显脏、要么显假。

---

## 五、按钮规范

`web/src/components/common/Button.tsx`，四个变体：
`primary` / `subtle` / `outline` / `ghost`，三个尺寸 `sm`(32px) / `md`(44px) / `lg`(48px)。

- `lg` 才是页面里真正的「主行动」（记一笔、选立场开辩）：`h-12` + `font-semibold`
- 主按钮和描边按钮有 `hover:shadow-card-hover`（轻微抬起）
- **刻意不做位移和缩放**：这个产品整天在安抚用户，界面上再来一堆动作会显得吵
- 需要「hover 才出现」的次要操作（比如列表里的归档）：
  `sm:opacity-0 sm:group-hover:opacity-100` —— **必须带 `sm:` 前缀**，
  否则触屏用户没有 hover，功能等于消失

---

## 六、空状态规范

用 `components/common/EmptyState.tsx`，不要自己拼一行灰字。

```tsx
<EmptyState title="还没有确认过的优势" art="seed" />
```

- 96px 线稿插画（`inbox` 收纳盒 / `mirror` 镜子 / `seed` 种子），`currentColor` + 淡灰 + 70% 透明
- 理由：一整块区域只有 13px 灰字时，视觉上跟「加载失败」长得一模一样，
  用户分不清「我还没做」和「功能坏了」
- 插画是**背景衬托**，不是主角：大、淡、单色

---

## 七、弱点便签

- 四态颜色走 `--sticky-*` 令牌（观察中淡黄 / 改善中白 / 已归档灰）
- **倾斜角度按 `card.id` 取模算**（`-2..2 × 0.6°`），不是固定值：
  整墙齐刷刷同一个角度看起来像排版事故，不像一张张贴上去的纸
- 观察中 + 改善中都倾斜，暂存（已归档）保持水平
- 折叠角用 `FoldedCorner` 组件

---

## 八、导航与新手态

- `components/layout/tabs.ts` 是**唯一**的 tab 定义，`SideNav`（桌面）和
  `TabBar`（移动）都读它 —— 加 tab 只改一处
- `lockForFresh: true` 的 tab 对新用户挂锁（弱点 / 资产）：点进去只有空页面，
  比直接说明「还差什么」更劝退
- 锁的判定在 `store/onboarding.ts`，**默认值是 `null`（还不知道）→ 不加锁**：
  宁可让用户点进空页面，也不要把其实有数据的入口锁掉
- 锁定点击是**拦跳转 + 弹说明**，不是禁用 —— 禁用态点了没反应，用户只会以为坏了

---

## 九、首页结构（2026-10 重排后）

首屏只有两个核心动作，其余「有真实数据才出现」：

| 顺序 | 区块 | 出现条件 |
|---|---|---|
| 1 | 状态行（日期 / 精力电池 / 连续天数） | 总是 |
| 2 | 问候语 | 总是 |
| 3 | **记一笔**（事件卡 hero） | 总是 |
| 4 | **3 分钟辩论**（有回环列回环，否则即兴辩论） | 总是 |
| 5 | 过去的你 | 有跨时间对比 |
| 6 | AI 观察 | **有真实观察**（空的时候整块不渲染） |

精力电池分档：`<20` 红 / `20–59` 黄 / `≥60` 绿，颜色只表示「还剩多少」，
不附加评价。

---

## 十、怎么验证（重要）

**不要只读代码，也不要只靠整页截图。**

本机有一套零依赖的浏览器工具（无头 Chrome + CDP）：

```
~/.dsh/tools/browser/cdp.mjs     驱动程序
~/.dsh/skills/browser-eyes.md    使用说明
```

能力：导航 / 按文字点击 / 真输入 / 截图 / 执行 JS / 抓控制台错误，
以及**按元素放大截图**（`clipText` + `clipSelector`）—— 28px 的小控件
必须凑近看才知道对不对。

三条方法论：

1. **几何问题量，不要目测**。视觉模型说「内容列偏右 87px」，实测左右各 256px 完全对称。
2. **全页截图里的固定底栏是假象**。`captureBeyondViewport` 会把 `position:fixed`
   的底栏画在文档中部，看起来像「卡片被压住」。判断遮挡要用视口截图 + 元素矩形。
3. **控制台错误是免费线索**。401/403/409 直接指到具体接口。

---

## 十一、已知缺口

- **手机端没有主题开关**：只做了桌面左侧导航。移动端底部栏只有 4 个 tab，
  要加只能放进资产页的「设置」分组
- 真机渲染（iOS 安全区、系统字体、Android 各厂商）未验证，只有 Chromium 模拟
- 「类名静默失效」的系统性检测脚本还没写（见第三节）

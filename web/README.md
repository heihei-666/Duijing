# 对镜 · 前端

用 AI 辩论房照见自己，用弱点回环改善自己。

- **技术栈**：Vite + React 18 + TypeScript + Tailwind CSS 3.4 + Zustand + React Router 6 + vite-plugin-pwa
- **不引入 UI 组件库**：全部组件手写（按钮、输入、抽屉、图标都在 `src/components`）
- **契约**：接口一律以 `../docs/API.md` 为准，字段名和枚举值**不翻译**，展示层再做中文映射

## 命令

```bash
npm install
npm run dev        # 开发服务器 http://127.0.0.1:5173，/api 代理到 http://127.0.0.1:3000
npm run typecheck  # tsc --noEmit
npm run build      # tsc --noEmit && vite build，产物在 dist/
npm run preview    # 预览构建产物
```

> **构建环境注意**：`vite-plugin-pwa` 生成 Service Worker 时走 workbox + `@rollup/plugin-terser`，
> 后者按 `os.cpus().length` 决定 worker 池大小。若所在容器 `os.cpus()` 返回空数组，
> 构建会卡住并报 `Unable to write the service worker file ... (terser) renderChunk`。
> 这属于环境问题。`vite.config.ts` 已检测到 `os.cpus().length === 0` 时自动退回
> `workbox.mode: 'development'`（只有 SW 不压缩、体积 +2KB 左右，缓存与更新行为一致）；
> 正常机器上仍然是 production + 压缩，无需任何额外操作。

## 目录

```text
src/
  api/
    types.ts            # 契约类型（枚举 + 核心对象），字段名照抄 API.md
    client.ts           # fetch 封装 + 按契约分模块的 api（authApi/statusApi/...）
  components/
    common/             # Button / Field / Sheet / EmptyState / BootSplash
    layout/             # AppShell（底部 4 Tab）/ TabBar / AuthLayout
    routing/            # RequireAuth / GuestOnly
    icons/              # 手写 SVG 图标
  features/
    debate/             # 辩论房：SSE 流式、四来源出题、邀请、复盘卡片、预约提醒
    weakness/           # 弱点墙（宽屏黑板拖拽 + 窄屏列表）、回环、演练日志
    assets/             # 优势库 / 原则库 / 事件卡历史 / 设置
    push/               # Web Push：权限状态机、VAPID 公钥、订阅管理
    status-bar/         # 首页四块 + 撑住率进度条 + 精力滑块
  lib/                  # rateColor / date / cn
  pages/                # 路由页面
  store/auth.ts         # Zustand：当前用户、登录、注册、登出、会话恢复
  styles/
    tokens.css          # 设计令牌（配色方案第十章，逐字采用，勿改色值）
    index.css           # tailwind 入口 + 基础样式
```

## 设计令牌

色值唯一来源是 `src/styles/tokens.css`（`--bg-* / --text-* / --primary / --sticky-* / --rate-*`）。
`tailwind.config.js` 只做「类名 → CSS 变量」映射，不写死任何色值：

| 类名 | 变量 | 用途 |
|---|---|---|
| `bg-base` `bg-surface` `bg-elevated` `bg-inset` | `--bg-*` | 页面底 / 卡片 / 次级面板 / 内嵌 |
| `text-primary` `text-secondary` `text-tertiary` `text-disabled` | `--text-*` | 中性文字（primary = 暖黑主文字，不是品牌蓝） |
| `text-brand` `bg-primary` `text-on-brand` | `--primary*` | 品牌蓝文字 / 主按钮底 / 主按钮字 |
| `bg-sticky-ai` `border-sticky-ai` `text-sticky-ai` | `--sticky-ai-*` | AI 候选便签（冷灰蓝） |
| `text-rate-low\|mid\|good\|great` | `--rate-*` | 撑住率取色 |

两个刻意的取舍：

1. `base` 只注册到 `backgroundColor`。若放进通用 `colors`，会生成 `.text-base { color: ... }`
   并与 Tailwind 内置字号 `.text-base` 撞名，正文可能被染成底色。
2. 色值是 `var(--x)` 字符串，Tailwind 无法做透明度运算，**不要写 `bg-primary/10`**，
   需要浅色请用 `--primary-light` 这类现成变体。

撑住率取色统一走 `rateColor(rate)`（`src/lib/rateColor.ts`），区间左闭右开：
`<40` 砖红 / `<60` 琥珀 / `<80` 灰绿 / `≥80` 深绿。

## 约定

- **认证**：httpOnly Cookie（`dj_token`），所有请求 `credentials: 'include'`，前端不存 token；
  401 由 `client.ts` 统一跳 `/login?from=<原地址>`（登录/注册/`auth/me` 除外）。
- **会话恢复**：应用启动调 `GET /api/auth/me`，恢复完成前停在启动页，避免受保护页面闪跳。
- **移动端优先**：内容居中限宽 `max-w-2xl`，底部固定 4 Tab，底栏留了 iOS 安全区。
- **配色克制**：状态栏只有两个彩色元素 —— 连续天数火苗色（`--warning`）和辩论按钮（`--primary`），
  其余全中性色；不用金色、奖杯色、游戏化色。

## 本阶段范围

**已完成（全部页面都已落地，不再是占位页）：**

| 页面 | 路由 | 说明 |
|---|---|---|
| 登录 / 注册 / 邀请落地 | `/login` `/register` `/join/:code` | 首个用户免邀请码，之后必须凭码 |
| 首页状态栏 | `/` | 日期 + 精力 + 连续天数 / 今天练什么 / AI 昨天观察到 / 两个快捷入口 |
| 辩论 | `/debates` | 新辩论（回环 / 事件卡 / 场景 / 自己出题四来源）、进行中、历史、P3 建议题 |
| 辩论房 | `/debates/:id` | SSE 流式、轮次提示、暂停 / 放弃本轮 / 结束复盘、邀请、预约提醒 |
| 弱点墙 | `/weaknesses` | 四区；≥768px 是 dnd-kit 黑板（三列 + 垃圾桶），窄屏自动降级为分区列表 |
| 弱点详情 | `/weaknesses/:id` | 撑住率趋势、回环列表与演练日志、垃圾桶倒计时 |
| 资产 | `/assets` | 优势库 / 原则库 / 事件卡历史（分页）/ 设置（含通知与账号数据） |

**待办**：深色模式（方案明确后置）、前端自动化测试与 ESLint/Prettier（尚未配置）。

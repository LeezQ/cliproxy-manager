# Stallion-X 定制版说明

本仓库 fork 自 [router-for-me/Cli-Proxy-API-Management-Center](https://github.com/router-for-me/Cli-Proxy-API-Management-Center)（MIT），
由 Stallion-X 自行维护，是 [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) 的管理端界面。

与上游的差异只有两类，并且刻意把改动面压到最小，以便长期 `git merge upstream/main`。

## 1. 功能裁剪

只保留五个入口：

| 入口 | 路由 | 源码 |
|---|---|---|
| 认证文件 | `/auth-files` | `src/features/authFiles` |
| OAuth 登录 | `/oauth` | `src/pages/OAuthPage.tsx` |
| 配额管理 | `/quota` | `src/features/quota` |
| 日志查看 | `/logs` | `src/pages/LogsPage.tsx` |
| 配置面板 | `/config` | `src/features/config` |

仪表盘、快速开始、AI 提供商、插件管理、插件商店、中心信息**只从路由和侧边栏摘除，源码目录保留不删**：

- `OAuthPage` 仍依赖 `features/plugins` 与 `features/providers` 里的工具函数，删目录就得改 OAuth 页面。
- 删目录会让上游对这些目录的每次修改都变成 modify/delete 冲突。
- Vite 会把未被引用的页面组件从产物中剔除，不影响体积。

涉及文件：

- `src/router/MainRoutes.tsx`：重写路由表，根路径与未知路径重定向到 `/auth-files`。
- `src/components/layout/MainLayout.tsx`：外壳已按 Stallion-X 主站重写（见第 2 节），导航分组 `navGroups` 只列出这五个入口。

**恢复某个功能**：在 `MainRoutes.tsx` 加回路由，并在 `MainLayout.tsx` 的 `navGroups` 中加回对应导航项（页面搜索会自动包含）。

### 1.1 不展示的上游提供商

`src/features/hiddenProviders.ts` 是唯一的名单（当前：`devin`、`meta`）。上游的类型、接口、配额逻辑与登录流程原样保留，
只在三个界面入口按名单过滤：

| 入口 | 过滤位置 |
|---|---|
| OAuth 登录卡片 | `src/pages/OAuthPage.tsx` 的 `providerCards` |
| 配额页提供商 tab | `src/features/quota/QuotaPage.tsx` 的 `TAB_IDS`（`QUOTA_TAB_ORDER` 保持上游原样，分组与缓存逻辑仍覆盖全部提供商） |
| 配置面板专属配置块 | `src/features/config/components/sections/SectionAdvanced.tsx` |

**恢复某个提供商**：把它的 id 从 `HIDDEN_PROVIDER_IDS` 删掉即可，其余代码无需改动。
相关的上游测试（`tests/devinOAuthUi.test.ts`、`tests/authFileCard.test.ts`、`tests/kimiOAuth.test.ts`、`tests/quotaToolbar.test.ts`）已改写为断言本 fork 的行为，合并上游时若被改回需要重新调整。

## 2. 视觉重构（Signal Atlas）

整个管理端的外壳、共享控件与五个页面都按 Stallion-X 主站（`stallion-x/web`）的 shadcn 冷灰工作台风格重做，
并**全局减弱动效**。配色、字体与主站一致：亮色 Control Fog、暗色 Night Relay、主色 Relay Blue。

### 2.1 样式分层

| 文件 | 职责 |
|---|---|
| `src/styles/stallion-x/_tokens.scss` | 设计令牌（亮 / 纯白 / 暗）。覆盖 `themes.scss` 同名变量，另有品牌层令牌：`--accent-bg/fg`、`--sidebar-*`、`--header-bg/border`、`--table-head-bg`、`--font-heading` 等；毛玻璃令牌全部置空 |
| `src/styles/stallion-x/_base.scss` | 排版、焦点环、细滚动条、系统级 reduced-motion 兜底 |
| `src/styles/stallion-x/_shell.scss` | 应用外壳：侧边栏、吸顶控制栏、内容区、顶栏菜单、页面搜索面板、移动端抽屉 |
| `src/styles/stallion-x.scss` | 以上三个分片的入口，在 `global.scss` 最后引入 |
| `src/styles/components.scss` | 全局基础类（`.btn` / `.input` / `.card` / `.modal` / `.notification` / `.empty-state`），已直接改为主站规格 |
| `src/styles/variables.scss` | SCSS 编译期常量：圆角 `$radius-lg` 8px、阴影减弱、`$transition-fast` 120ms / `$transition-normal` 150ms。颜色会被 `sass:color` 调用，必须是真实色值 |

`global.scss` **不再引入上游 `layout.scss`**，外壳由 `stallion-x/_shell.scss` 完整实现（类名 `.content`、`.main-content` 等与上游保持一致，`scrollLock.ts` 依赖 `.content`）。
`layout.scss`、`components/common/PageTransition*` 文件保留未删，仅不再使用，避免合并上游时出现 modify/delete 冲突。

### 2.2 外壳与公共组件

- `src/components/layout/MainLayout.tsx`：重写。左侧侧边栏（品牌区、按「网关 / 观测 / 控制」分组且带右侧说明的导航、底部连接状态与服务端版本，⌘B 收起为图标栏）；右侧吸顶控制栏（侧边栏开关、页面搜索、连接状态、刷新、语言、主题、登出）。插件页入口不再渲染。
- `src/components/layout/NavSearchDialog.tsx`：顶栏「搜索页面或功能」面板，⌘K / Ctrl+K 打开，本地过滤导航项，方向键 + Enter 跳转。快捷键判断在 `src/utils/sidebarShortcut.ts`。
- `src/components/common/PageHeader.tsx`：页面标题区（标题 + 说明 + 统计条 + 操作按钮），五个页面顶部统一使用。多个统计项合并成一条带分隔线的白底横条；操作按钮固定在右上角。
- 字体：所有标题沿用正文字体（Geist + 系统中文字体），层级只靠字号字重表达。IBM Plex Sans Condensed 只含拉丁字形，用在中英混排标题上会一半窄体一半常规体，因此仅保留给品牌方块里的单个字母。
- 共享控件（`src/components/ui/**`、`SecondaryScreenShell`、`excludedModels`、`modelAlias`）：Select / 输入框 36px、8px 圆角、`--border-primary` 描边；Switch、Checkbox、Table、EmptyState 对齐 shadcn。
- 登录页：去掉左侧大字品牌区，改为冷灰底 + 居中白色登录卡片，卡片顶部品牌行与侧边栏一致。

### 2.3 页面

| 页面 | 主要变化 |
|---|---|
| 认证文件 | `PageHeader` + 统计条；筛选卡片头部为提供商 tabs，右端放「删除全部」，下方为搜索 / 状态 / 排序 / 显示选项；凭证卡片无阴影、悬停只变边框；删除 `VaultHeader` / `VaultPulse` 组件 |
| OAuth 登录 | 提供商卡片改为两列网格；授权进行中的链接、回调输入、状态徽标统一样式 |
| 配额管理 | `PageHeader` + 统计条；tabs 与排序下拉合并为筛选卡片；未加载的卡片是单行「点击刷新」按钮（不再是虚线大框）；进度条扁平化（按剩余量取健康 / 决策 / 故障色）；删除套餐徽标的液体、光泽、呼吸效果 |
| 日志查看 | 筛选卡片（搜索、结构化筛选、视图开关）+ 日志卡片（头部放刷新 / 下载 / 清空 / 全屏，等宽时间、级别徽标）；错误请求日志改为表格卡片 |
| 配置面板 | `PageHeader` 右侧放搜索 / 可视化-源码切换 / 重新加载；下划线分区 tab（无图标）；分区卡片去掉序号与图标；API 密钥为单层边框列表（无序号）；开关类字段改为左文右控件的行 |
| OAuth 编辑二级页 | 标题只由 `SecondaryScreenShell` 顶部展示，内容区保留一句说明 |

### 2.4 动效策略

- `src/hooks/motion.ts` 中 `APP_MOTION_REDUCED = true`，`prefersReducedMotion()` 恒为 true：`useRevealGroup` / `useRevealOnScroll` / `useCountUp`、悬浮操作条、平滑滚动全部降级。改回 false 即恢复按系统偏好判断。
- 外壳不再挂载 `PageTransition`，路由切换直接渲染并回到顶部。
- CSS 只保留：加载旋转、骨架屏 shimmer、配置字段跳转高亮（0.8s 背景色）、Modal / Sheet / 通知的 120ms 淡入淡出（JS 中的关闭计时同步改为 120ms）。
- 入场 / 级联 / 位移 / 缩放 / 回弹 / 光泽类 `@keyframes` 与 hover 的 `transform` 已全部删除；`transition` 只作用于颜色类属性。

**后续改视觉的约定**：只使用 `_tokens.scss` 中的 CSS 变量，不写死颜色；卡片不加阴影、层级靠边框；新页面顶部用 `PageHeader`；不要新增装饰性动画。
回归测试见 `tests/stallionShell.test.ts`（动效策略、外壳不挂载页面切换动画、不引入 `layout.scss`、外壳文案四语齐全）。

## 2.5 界面语言

只提供简体中文与英文（`src/utils/constants.ts` 的 `LANGUAGE_ORDER`）。
繁体中文与俄文的语言包保留未删（上游合并与部分测试依赖），但不在界面中提供切换；
已保存的其他语言会失效并按浏览器语言重新选择：任何中文（含繁体地区）用简体中文，其余用英文（`src/utils/language.ts`）。
新增或修改文案时，四个语言文件仍需同步更新，以免合并上游时缺 key。

## 3. 移除推广与运营内容

上游在界面和文档里放了赞助商广告与带推广参数的注册链接，本 fork 全部移除：

| 位置 | 上游内容 | 处理 |
|---|---|---|
| 配置面板「代理 URL」字段下方 | 「没有合适的代理？」+ BestProxy 推广链接 | `src/features/config/sponsors.ts` 置为空数组，上游约定为空时整行不渲染；删除其 logo 资源 |
| OAuth 登录页顶部 | Kimi 置顶推荐卡，含带 `aff=` 参数的「立即注册」按钮 | `src/pages/OAuthPage.tsx` 去掉置顶与注册按钮，Kimi 与其他提供商平级展示 |
| 侧边栏 | 配置了 APIKEY.FUN 时把「快速开始」替换成赞助商入口 | `MainLayout.tsx` 删除相关判断与导入 |
| README / README_CN | 赞助商段落与图片 | 删除段落和 `assets/apimart-*.png`，顶部加 fork 说明 |

**合并上游时注意**：上游频繁增删赞助商。凡是 `sponsors.ts`、`OAuthPage.tsx` 推荐卡、README 赞助段落出现冲突，一律保留本 fork 的无推广版本；合并后执行下面的检查，确认产物里没有混入新的推广链接。

```bash
bun run build
grep -o -i -E "aff=|keyword=|utm_|sponsored|apimart|apikey\.fan|bestproxy" dist/index.html | sort | uniq -c
```

多语言文件里仍有被裁页面用到的赞助商名称文案（如 APIKEY.FUN、FennoAI、七牛云），它们不会在保留的五个页面上显示。
这几个 JSON 上游改动频繁，为避免每次合并冲突而未删除。

## 4. 认证文件的「历史残留错误」

上游面板直接按后端的 `status` / `status_message` 亮告警。但 CPA 按模型记错误、按账号汇总状态：
某个冷门模型撞上一次临时错误（如 `server_is_overloaded`）后，如果再没有请求分到它，
这个模型的 `LastError` 就不会清除，整个账号的 `status` 一直停在 `error`，
`status_message` 一直显示那条旧错误——即使主力模型每天成功几千次。

本 fork 在 `src/features/authFiles/constants.ts` 增加 `isStaleAuthFileError`：

| 条件 | 判定 | 卡片 |
|---|---|---|
| 后端标记 `unavailable`（令牌失效等硬故障） | 故障 | 告警色，计入「问题凭证」 |
| `status=error` 或非健康消息，且最近 30 分钟有成功请求 | 历史残留 | 显示「健康」，旧错误降级为一行灰字，不计入「问题凭证」 |
| 有错误信号，但最近 30 分钟没有任何成功 | 故障 | 告警色，计入「问题凭证」 |

「最近 30 分钟」取 `recent_requests` 末尾 3 个 10 分钟分桶。完全没有近期流量时无法区分，保守地按故障处理。
测试见 `tests/authFileProblemStatus.test.ts`。服务器上的 `cpa-account list` / `doctor` 使用同一口径。

**合并上游时注意**：`hasAuthFileStatusWarning` 与 `isProblemAuthFile` 若在上游被改动，保留本 fork 对历史残留的排除逻辑。

## 5. 认证文件与配额页的列表布局

上游只有卡片网格，每张卡片要占半屏高度，账号一多就得一直往下翻。
本 fork 增加「卡片 / 列表」切换（工具栏「显示选项」左侧的两个图标），**默认列表**，切换后的选择会记住。

列表布局一行一个凭证，按提供商分组，组头带数量：

| 列 | 内容 |
|---|---|
| 账号 | 邮箱；下方是套餐（Pro 等付费档用主色）、权重、优先级、备注 |
| 状态 | 圆点 + 文字，文案判定与卡片完全一致 |
| 请求健康度 | 成功 / 失败计数 + 压矮的请求方块条（悬停提示与卡片相同） |
| 额度 | 各额度窗口横向并排；有倒计时就省掉绝对日期，给窗口标签腾位置 |
| 操作 | 模型、刷新令牌、下载、设置、删除、启用开关 |

只有存在告警、历史残留错误或冷却信息时，行下方才多出一行说明，普通行保持同一高度。

- **加载本页额度**：位于第一个分组标题同一行的右侧，一次查询本页所有支持额度的凭证，复用额度页的批量加载（`useQuotaBatchLoader`）；结果写入共享缓存，切回卡片视图不必重新拉取
- **分页**：列表、紧凑卡片、普通卡片三档各自记忆页大小，列表默认 30（单页上限）
- **套餐来源**：取凭证文件名后缀（`-pro.json` / `-plus.json` …），只作展示。新账号刚入库时后端可能先命名为 free，跑过请求后会改名
- **响应式**：≤1180px 拆成两行（账号 / 状态 / 操作在上，健康度与额度在下）；≤768px 单列堆叠
- 行内不展示套餐 chip、重置积分明细和「重置额度」按钮，这些低频信息留在卡片视图和额度页

实现：`AuthFileRow`、`AuthFileRow.module.scss`、`AuthFileQuotaRow.module.scss`（只放覆盖项，与卡片额度样式合并后使用）、
`listView.ts`（套餐识别与分组，测试见 `tests/authFilesListView.test.ts`）。

### 5.1 配额页

同样默认列表、可切回卡片（排序下拉右侧），选择在本会话内记住（`quotaPage.uiState`，sessionStorage）。
每行：账号（邮箱 + 提供商）| 套餐信息一列（套餐、续期时间、主动重置次数，固定 230px 宽）+ 各额度窗口横向并排 | 重置 / 刷新额度。

- **操作列定宽 264px**：每行是独立的 grid，`auto` 列会随按钮个数变化（没有重置次数的号不显示「重置额度」），
  导致各行的套餐与额度列错位
- 重置积分的逐条到期明细只在卡片视图展示
- 实现：`QuotaRow`、`QuotaRow.module.scss`、`QuotaBodyRow.module.scss`（只放覆盖项，与 `QuotaBody.module.scss` 合并）、
  `groupQuotaEntriesByType`（`features/quota/logic.ts`）

### 5.2 共用的布局切换

`src/components/common/LayoutToggle.tsx` 为两个页面共用的「卡片 / 列表」切换，取值与守卫在同目录的 `layoutMode.ts`
（与组件分开是为了不破坏 React Fast Refresh）。文案在 `common.layout_*`。

## 同步上游

先做一次性设置，阻止上游标签被带进本仓库：

```bash
git config remote.upstream.tagOpt --no-tags
```

```bash
git fetch upstream
git merge upstream/main
bun install --frozen-lockfile
bun run verify
```

**绝对不要 `git push origin --tags` 或 `git push --follow-tags`。**
批量推标签会把线上面板静默换回上游版本，原因见
[DEPLOYMENT.md 5.3](./DEPLOYMENT.md#53-批量推标签会把线上换回上游版本)。
发布一律用 `git push origin vX.Y.Z` 单推。

视觉重构改动了五个页面及共享控件的大量样式文件，合并上游涉及这些文件时冲突会较多：
原则上保留本 fork 的结构与样式，只把上游的逻辑 / 文案 / 新字段合入。合并后在浏览器里过一遍五个页面的亮色与暗色，
并确认没有重新引入 `layout.scss`、`PageTransition` 或装饰性动画。

## 依赖安装注意

本机 bun 若配置了国内镜像，`bun add` 会把 `bun.lock` 里所有包的下载地址改写成镜像地址，
产生几百行无关 diff 并与上游锁文件冲突。新增依赖时显式指定官方源：

```bash
BUN_CONFIG_REGISTRY=https://registry.npmjs.org/ bun add <package>
```

## 本地预览

需要一个 CLIProxyAPI 实例提供 `/v0/management` 接口。可下载上游 release 的二进制，用最小配置在本机回环地址启动：

```yaml
host: "127.0.0.1"
port: 18317
remote-management:
  allow-remote: false
  secret-key: "local-preview-key"   # 仅本地预览用，勿用于生产
  disable-control-panel: true       # 不下载官方管理页
auth-dir: "./auths"
api-keys:
  - "local-preview-api-key"
logging-to-file: true
```

然后 `bun run dev`，登录页勾选「自定义连接地址」填 `http://127.0.0.1:18317`，管理密钥填上面的 `secret-key`。

## 部署

发布流程、线上配置、验证方法、踩过的坑和回滚步骤都在 [DEPLOYMENT.md](./DEPLOYMENT.md)。

一句话版本：后端从本仓库 latest release 拉取名为 `management.html` 的资产，
所以发版就是创建一个带该资产的 release，打标签即可。

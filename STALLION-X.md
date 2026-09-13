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
`release.yml` 的触发条件是 `push: tags: ['v*']`，批量推送会为每一个新的上游标签触发一次构建。
那些构建产物里没有 Stallion-X 的任何改动，发布后又会成为 latest release，
线上面板将在 3 小时内被静默换回上游版本。发布一律用 `git push origin vX.Y.Z` 单推。

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

CLIProxyAPI 会调用 `https://api.github.com/repos/{owner}/{repo}/releases/latest`，
从 `panel-github-repository` 指向仓库的 latest release 下载名为 `management.html` 的资产，
校验 digest 后缓存到工作目录的 `static/management.html`。同步周期为 3 小时，进程启动时也会立即拉取一次。

线上实际配置（cliproxy.stallion-api.com）：

```yaml
remote-management:
  disable-control-panel: false                                    # 为 true 会关掉整个管理页路由
  panel-github-repository: "https://github.com/LeezQ/cliproxy-manager"
  # disable-auto-update-panel 保持缺省（false），自动更新正是发布链路的最后一环
```

### 发布新版本

Actions 已在本 fork 启用，无需再手动开启。

```bash
bun install --frozen-lockfile
bun run verify
git push origin main
git tag v1.23.0
git push origin v1.23.0        # 只推这一个 tag，绝不能用 --tags
```

`.github/workflows/release.yml` 会构建并把 `dist/index.html` 重命名为 `management.html` 上传到 release。
标签名会经由工作流的 `VERSION` 环境变量注入 `__APP_VERSION__`，直接显示在界面上，
也是判断线上跑的是哪个版本最省事的依据。

本 fork 的版本线从 `v1.23.0` 起，高于全部继承自上游的标签（最新 `v1.22.18`）。

### 改配置不需要重启

后端有配置热重载，改完 `config.yaml` 约 10 秒内生效，不会中断在途的流式响应：

```bash
cp -p /opt/cliproxy/config.yaml /opt/cliproxy/config.yaml.bak-$(date +%F-%H%M)
sed -i 's#panel-github-repository: .*#panel-github-repository: "https://github.com/LeezQ/cliproxy-manager"#' /opt/cliproxy/config.yaml
chown cliproxy:cliproxy /opt/cliproxy/config.yaml && chmod 600 /opt/cliproxy/config.yaml
tail -f /opt/cliproxy/logs/main.log | grep -E "config_reload|management asset"
```

两点注意：systemd 单元没有 `ExecReload`，`systemctl reload` 会失败；
短时间内连改两次配置可能撞上 `management asset sync skipped by throttle`，改一次就好。

### 验证

```bash
gh api repos/LeezQ/cliproxy-manager/releases/latest --jq '{tag:.tag_name, asset:.assets[0].name, digest:.assets[0].digest}'
ssh cliproxy-server 'sha256sum /opt/cliproxy/static/management.html'
curl -sS https://cliproxy.stallion-api.com/management.html | shasum -a 256
curl -sS https://cliproxy.stallion-api.com/management.html | grep -c 'v1\.23\.0'
```

三处哈希必须一致。日志里要出现 `management asset updated successfully`，
**不能是** `management asset updated from fallback` —— 见下面这条。

### 静默回退到上游

二进制里硬编码了 `router-for-me/Cli-Proxy-API-Management-Center` 作为兜底源。
本 fork 的 release 查不到、资产缺失、GitHub API 匿名限流（每 IP 每小时 60 次）或 digest 不匹配时，
后端会**不报错地**改发上游的面板。所以判断部署是否成功不能只看「页面能打开」，
要看日志措辞和 sha256。

### 回滚

全部是改配置即可，约 10 秒生效，不需要重启：

1. 把 `panel-github-repository` 改回上游仓库地址
2. GitHub 不可达时，加 `disable-auto-update-panel: true` 再手工放一个已知可用的 `management.html` 进 `static/`
3. 极端情况 `disable-control-panel: true` 关掉整个面板路由，代理 API 不受影响

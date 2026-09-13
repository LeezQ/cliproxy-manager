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
- `src/components/layout/MainLayout.tsx`：用 `filterVisibleNavGroups` 包住上游导航数组，只改了两行调用。

**恢复某个功能**：在 `MainRoutes.tsx` 加回路由，并把路径加进 `MainLayout.tsx` 的 `VISIBLE_NAV_PATHS`。

## 2. 视觉换肤（Signal Atlas）

配色、字体与 Stallion-X 主站（`stallion-x/web/src/index.css`）保持一致：亮色 Control Fog、暗色 Night Relay、主色 Relay Blue。

- `src/styles/stallion-x.scss`：**品牌层，所有视觉差异集中在这里**。在 `global.scss` 最后引入，靠「同选择器、后声明」覆盖 `themes.scss` 与 `layout.scss`。文件头注释里有上游令牌到主站令牌的映射表。
- `src/styles/variables.scss`：SCSS 编译期色值与字体栈。这里的颜色会被 `sass:color` 函数调用，必须是真实色值，不能换成 CSS 变量。
- `src/main.tsx`：引入 Geist、JetBrains Mono、IBM Plex Sans Condensed 字体，由 `vite-plugin-singlefile` 内联进产物。
- `src/pages/LoginPage.module.scss`：登录页左侧品牌区底色改为读取 `--brand-panel-bg`。

**改视觉时优先只动 `stallion-x.scss`**，不要直接改上游的 `themes.scss` / `layout.scss`，否则合并上游时会冲突。

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

```bash
git fetch upstream
git merge upstream/main
bun install --frozen-lockfile
bun run verify
```

冲突通常只会出现在上面列出的少数文件里。合并后在浏览器里过一遍五个页面的亮色与暗色。

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

CLIProxyAPI 会从 `panel-github-repository` 指向仓库的 latest release 下载名为 `management.html` 的资产，
并定期自动更新（带 digest 校验）。把它指向本 fork 即可替换官方管理页：

```yaml
remote-management:
  panel-github-repository: "https://github.com/LeezQ/cliproxy-manager"
```

发布新版本：

1. 首次使用需在 GitHub 本仓库的 Actions 页面手动启用工作流（fork 默认禁用 Actions）。
2. 打 `vX.Y.Z` 标签并推送，`.github/workflows/release.yml` 会构建并把 `dist/index.html` 重命名为 `management.html` 上传到 release。

```bash
git tag v0.1.0 && git push origin v0.1.0
```

注意：若 `disable-control-panel: true`，后端会连管理页的 HTTP 路由一起关闭，不能用来托管本仓库产物。

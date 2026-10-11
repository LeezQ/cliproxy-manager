# 上游同步评估（2026-10-08）

已执行 `git fetch upstream --no-tags`，上游 main 为 `5aa1ad64a6494e3741e7d7ffec737107400a62b4`。
本 fork main 为 `7249c97`，共同祖先为 `4530da2`；上游有 57 个祖先图上尚未合入的提交（含 merge commit）。
`b8ed42a` 的补丁已合入为 `99d08ae`；`ee27516` 的 Autocomplete portal 已适配合入为 `eafc53e`，不应重复应用。
已补设本地 `remote.upstream.tagOpt=--no-tags`。

本次是拉取与合入评估：没有合并到 main、提交、推送或发布。以下试合均在临时 detached worktree 中完成。

## 第一批：已试合并通过完整检查

建议按下表顺序选择性合入，不合并整个 upstream/main。

| 提交 | 更新 | 判断 |
|---|---|---|
| `45181b4` | Codex credit 余额 / 无限额 | 使用已有 usage 请求的 credits 字段，不新增管理接口；卡片已有套餐区域扩展一项。列表视图隐藏该区域，若希望列表也展示，需另行调整摘要。 |
| `715cab4` | Claude 云端会话额度标签 | 区分美元 credit 池与 Fable 窗口，避免标签错误或额度被隐藏；使用已有 api-call 与数据解析路径。 |
| `dfc1b1c` | 中文套餐名保留 Free / Pro / Team | 仅修改简繁中文显示文案，无接口变化。 |
| `32e7eb9` | Kimi 月额度与国际账号 | 增加 limit_month_total 解析，将 kimi-ai 归入 Kimi 配额。 |
| `33af966` | Kimi 实际域名解析与过期请求保护 | 建议紧跟上一项合入；下载凭据读取 domain / base_url，目标仅允许 kimi.com / kimi.ai，不缓存凭据，避免国际账号请求到错误域名。 |

验证结果：五个补丁均通过 `git apply --check`，组合试合后 `bun run verify` 通过：
869 项测试、0 失败，ESLint 通过，TypeScript 与 Vite 生产构建通过，产物仍为单文件 index.html。
另运行 Codex / Claude 的 53 项聚焦测试、Kimi 的 41 项聚焦测试及 TypeScript 检查，全部通过。

后端证据：本地 `../CLIProxyAPI` HEAD 为 `673131f5`（2026-09-23）。
`internal/api/server_management.go` 提供 `/v0/management/api-call` 和 auth-files download；
`internal/watcher/synthesizer/file.go` 保留 Kimi domain / base_url 并解析实际域名。
这只能证明本地后端契约；本次未连接生产环境验证，也未进行浏览器视觉 / 交互检查。

## 第二批：适合移植或单独验证

| 提交 | 建议与依赖 |
|---|---|
| `b87b948` | 优先移植日志全屏 Escape 对 defaultPrevented 的判断，防止关闭 Select 时同时退出全屏。当前代码在 src/pages/LogsPage.tsx，上游在 src/features/logs，需适配路径；无需为了这一修复重构日志页。 |
| `ee79a79` | Codex Pro 20x / Pro 5x 更名为 Pro 200 / Pro 100。补丁通过应用检查；会影响本 fork 的列表摘要和显示断言，需同步相关测试与文档。这是命名更新，不应改变服务器套餐权重。 |
| `556a2b2` + `20b2372` | API Key 本地名称和认证文件错误文案搜索。名称是浏览器本地备注，并非后端新字段；两项应一起评估，避免使用可逆存储保存原始 API Key 作为索引。后者引入 @noble/hashes，须遵守 Bun 官方 registry / lockfile 约定。 |
| `69ebed4` + `77f10d5` | xAI 订阅名称补充与共享额度用量明细。前者增加可选后台 enrichment，后者依赖它的渲染结构；前者通过补丁应用检查，但本次未试合测试这一组。需核对本 fork 列表摘要、时间线和异步缓存保护。不能仅因这些提交晚于 v8 迁移就认定配额逻辑不兼容。 |
| `8271143` | YAML 1.1 yes/no/on/off 布尔解析有移植价值。上游修改的 visualConfigAdditions.ts / visualConfigServer.ts 在本 fork 不存在，不能直接应用；应在现有 v0 useVisualConfig 中适配，不引入 v8 字段路径。 |
| `59228ea` | 停用卡片弱化，纯视觉、非接口依赖。优先级低，需结合本 fork 冷灰样式、列表视图和可读性决定是否采用。 |
| `d554bb0` + `e5fb14c` + `752e0ee` + `2ce627d` | Claude reset grants 与详情。API 层复用 api-call 调 Anthropic，不是天然依赖 v8；但增加额度消费操作、弹窗与卡片状态，需完整移植和交互验证。默认列表没有上游 QuotaCard 的完整操作入口，须单独设计入口；不要带回 demo 或上游样式。 |

## 暂缓直接合入

- **整批 v8 配置 / 提供商改造**：`88d1867`、`084f429`、`254594a`、`9247abd`、提供商高级策略系列、`3a71fcf`、`bb32461`、`efe96bf` 等。上游管理前缀为 `/v8/management`，配置读写迁到 server / upstream / client 树；本 fork 仍是 v0 契约。
- **配置并发 patch / 草稿恢复**：`8182892`、`9d5c0d9`、`5521c4b` 等依赖上游新的 config patch 流程，不能仅取后面的修复提交。
- **`f1ee52c` duration fallback**：本 fork 不存在上游新增的 duration 校验模块和对应字段，当前无需照搬。
- **`ebb4289` 全局 GitHub token**：写入 `server.github-token`，属于 v8 server 配置字段；本地 v7 后端配置没有这一契约。
- **`2c234bc` / `18ca877` 冷却清理**：上游请求 `/routing/cooldown/reset`，本地后端只有 `/reset-quota`。后者有 `status / auth_index / models` 应答，但应先核对处理语义再适配。Codex 兑换结果 code 校验可以单独移植，整项不能直接 cherry-pick。
- **`326cb6d` 凭据策略 / 批量刷新**：上游使用 `/credentials/*` 与策略字段；本地后端使用 `/auth-files/*`。本地实际已有 `/auth-files/refresh`，所以旧记录的“刷新路由尚未匹配”应理解为上游契约不匹配，而不是后端完全不支持刷新；单项可适配，整项暂缓。
- **日志目录与大规模 UI 改造**：`deab4d6`、`d82d954`、`edc10b4` 会覆盖本 fork 按请求聚合、列表与定制工具栏；优先移植独立修复。
- **越南语 / 韩语**：本 fork 只提供简体中文与英文，不需要 `fc9b8e2`、`f03160e` 及后续 locale 补全；标题泛化的 `6abace9` 实际只修改越南语。
- **插件 logo `673b8ee`**：插件页未开放，收益较低，可以保留为未来候选。

后续实际合入第一批后，仍应检查认证文件 / 配额页的亮暗主题、列表与卡片显示，以及构建产物的推广内容扫描，再决定提交或发布。

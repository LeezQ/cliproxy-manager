# 部署手册

本文档描述如何把本仓库构建的管理面板发布到线上 CLIProxyAPI 实例。

线上环境：`cliproxy.stallion-api.com`（SSH 别名 `cliproxy-server`），
后端 CLIProxyAPI，工作目录 `/opt/cliproxy`，前置 Caddy 反代到 `127.0.0.1:8317`。

## 1. 分发机制

后端不从本仓库拉源码，而是拉构建好的单文件产物：

```
GitHub Release (latest)          CLIProxyAPI                     浏览器
  management.html        ──拉取──>  static/management.html  ──GET──>  /management.html
```

具体行为：

- 调用 `https://api.github.com/repos/{owner}/{repo}/releases/latest`，
  其中仓库由配置项 `panel-github-repository` 指定
- 在该 release 的资产里找名为 `management.html` 的文件
- 比对 GitHub 返回的 `digest` 字段，与本地缓存不一致才下载
- 缓存到工作目录下的 `static/management.html`
- 同步周期 3 小时，进程启动时立即拉取一次

因此发布一个新版本 = 在本仓库创建一个带 `management.html` 资产的 release。
剩下的事后端自己会做。

## 2. 线上配置

`/opt/cliproxy/config.yaml` 中与面板相关的部分：

```yaml
remote-management:
  disable-control-panel: false                                    # 为 true 会关掉整个管理页路由
  panel-github-repository: "https://github.com/LeezQ/cliproxy-manager"
  # disable-auto-update-panel 保持缺省（false），自动更新正是发布链路的最后一环
```

当前线上版本：**v1.23.0**。

## 3. 发布新版本

### 3.1 前置检查

```bash
bun install --frozen-lockfile
bun run verify                  # test + lint + build，必须全绿
```

本仓库是公开的，产物会被公网直接下载，发布前扫一遍敏感串：

```bash
grep -o -i -E "aff=|utm_|sponsored|referral|sk-ant-[A-Za-z0-9_-]{10,}|cpa-[0-9a-f]{20,}" dist/index.html | sort | uniq -c
```

`rel="noopener noreferrer sponsored"` 是合法的 HTML 属性，可以忽略；其余命中都要查清楚。

### 3.2 打标签

版本线从 `v1.23.0` 起，高于全部继承自上游的标签。递增时沿用这条线。

```bash
git push origin main
git tag vX.Y.Z
git push origin vX.Y.Z          # 只推这一个标签，绝不能用 --tags，原因见 5.3
```

### 3.3 生成 release

目前 **Actions 尚未放行**（原因见 5.1），需要本地构建后手工发布：

```bash
VERSION=vX.Y.Z bun run build
cp dist/index.html /tmp/management.html
git log --pretty=format:"- %h %s" <上一个标签>..vX.Y.Z > /tmp/notes.md
gh release create vX.Y.Z /tmp/management.html -R LeezQ/cliproxy-manager \
  --title "vX.Y.Z" --notes-file /tmp/notes.md
```

必须显式传 `VERSION`。否则 `getVersion()` 会退到 `git describe`，
产物里写进的是类似 `v1.22.16-2-gbd6edde` 的字符串，就失去版本判断的意义了。

放行 Actions 之后这一步可以删掉：`.github/workflows/release.yml` 会在标签推送时
自动执行同样的构建、把 `dist/index.html` 重命名为 `management.html` 并创建 release，
`VERSION` 由工作流从标签名注入。

### 3.4 让线上生效

发完 release 什么都不用做，后端 3 小时内自动拉取。想立刻生效就重启：

```bash
ssh cliproxy-server 'systemctl restart cliproxy'
```

重启约 1 秒，会中断在途的流式响应，低峰期做。

## 4. 验证

```bash
# a. release 侧
gh api repos/LeezQ/cliproxy-manager/releases/latest \
  --jq '{tag:.tag_name, asset:.assets[0].name, digest:.assets[0].digest}'

# b. 服务器侧
ssh cliproxy-server 'sha256sum /opt/cliproxy/static/management.html'
ssh cliproxy-server 'grep "management asset" /opt/cliproxy/logs/main.log | tail -3'

# c. 公网侧
curl -sS https://cliproxy.stallion-api.com/management.html | shasum -a 256
curl -sS https://cliproxy.stallion-api.com/management.html | grep -c 'vX\.Y\.Z'
```

三处哈希必须完全一致，版本字符串至少出现一次。

日志里要出现 `management asset updated successfully`，
**不能是** `management asset updated from fallback`，原因见 5.2。

最后浏览器强制刷新（Cmd-Shift-R），用 CPA Management Key 登录，
确认 Auth Files、OAuth、Quota、Logs、Config 五个模块都能正常读取。

## 5. 陷阱

以下每一条都是实际踩过的。

### 5.1 fork 的 Actions 有一道隐藏门禁

仓库级 `actions/permissions` 显示 `enabled: true`，两个 workflow 也都是 `active`，
但 GitHub 对 fork 另有一道网页门禁。没在 Actions 页面点过
「I understand my workflows, go ahead and enable them」之前，
push 和 tag 都不会触发任何运行，`actions/runs` 的 `total_count` 恒为 0，
且不产生任何报错或提示。

点一次即可永久放行，之后 3.3 可以走自动流程。

### 5.2 后端会静默回退到上游面板

二进制里硬编码了 `router-for-me/Cli-Proxy-API-Management-Center` 作为兜底源。
本仓库的 release 查不到、资产缺失、GitHub API 匿名限流（每 IP 每小时 60 次）
或 digest 不匹配时，后端会**不报错地**改发上游的面板。

所以判断部署成功与否不能只看「页面能打开」，要看日志措辞和 sha256。

### 5.3 批量推标签会把线上换回上游版本

`release.yml` 的触发条件是 `push: tags: ['v*']`。同步上游后如果
`git push origin --tags` 或 `git push --follow-tags`，
会为每一个新的上游标签触发一次构建。那些产物里没有本 fork 的任何改动，
发布后又成为 latest release，线上面板将在 3 小时内被静默换回上游版本。

已做的防护：`git config remote.upstream.tagOpt --no-tags`，
让 `git fetch upstream` 不再把上游标签带进本仓库。

发布一律用 `git push origin vX.Y.Z` 单推。

### 5.4 改 config.yaml 不能用 sed -i

`sed -i` 是写临时文件再 rename，会换掉 inode。后端的 file watcher 盯的是原来那个 inode，
改完不触发热重载，日志里也毫无痕迹，排查时极易误判成「热重载不管用」。

必须原地截断写入。正确做法：

```bash
ssh cliproxy-server
cp -p /opt/cliproxy/config.yaml /opt/cliproxy/config.yaml.bak-$(date +%F-%H%M)
cp /opt/cliproxy/config.yaml /root/config.staged
vi /root/config.staged                                  # 改这个副本
cp /root/config.staged /opt/cliproxy/config.yaml        # 原地写回，inode 不变
chown cliproxy:cliproxy /opt/cliproxy/config.yaml && chmod 600 /opt/cliproxy/config.yaml
rm -f /root/config.staged
tail -f /opt/cliproxy/logs/main.log | grep -E "config_reload|management asset"
```

约 10 秒内会看到 `config successfully reloaded`，不中断在途请求。

已经误用过 `sed -i` 的话 watcher 就失效了，只能 `systemctl restart cliproxy` 让它重新挂上。

### 5.5 其余配置操作注意事项

- systemd 单元没有 `ExecReload`，`systemctl reload cliproxy` 会直接失败，只有 `restart`
- root 改完配置必须 `chown cliproxy:cliproxy` 且 `chmod 600` 改回去，
  否则面板自己的配置编辑器写不进文件
- 短时间内连改两次配置可能撞上 `management asset sync skipped by throttle`，改一次就好

## 6. 回滚

前两级都只改配置，不需要重启，约 10 秒生效。

| 级别 | 场景 | 操作 |
|---|---|---|
| 1 | 新版面板有问题 | 把 `panel-github-repository` 改回上游仓库地址 |
| 2 | GitHub 不可达 | 加 `disable-auto-update-panel: true`，手工放一个已知可用的 `management.html` 进 `static/` |
| 3 | 面板本身出严重问题 | `disable-control-panel: true` 关掉整个面板路由，代理 API 不受影响 |

服务器上保留的回滚件：

```
/opt/cliproxy/config.yaml.bak-before-own-panel        切换前的配置
/opt/cliproxy/management.html.upstream-v1.22.18       切换前的上游面板产物
```

GitHub 侧也可以 `gh release delete vX.Y.Z`，让 latest 指回旧版本。
但注意 release 全删光会触发 5.2 的静默回退，优先用级别 1。

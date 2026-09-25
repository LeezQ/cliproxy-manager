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

当前线上版本：**v1.31.0**。

### 2.1 Caddy 侧的管理面保护

`/etc/caddy/Caddyfile` 里有两条与面板直接相关的规则，改动前先备份
（目录下已有若干 `Caddyfile.bak-*`）：

```caddyfile
# 已废弃接口，直接由 Caddy 返回 404，不进入 CPA 的鉴权中间件
handle /v0/management/capabilities {
    respond 404
}

# 管理面 IP 白名单；业务接口 /v1/* 不在其中，不受影响
@admin_denied {
    path /management.html /v0/management /v0/management/*
    not remote_ip <管理出口IP>
}
handle @admin_denied {
    respond "forbidden: {http.request.remote.host} not in management allowlist" 403
}
```

白名单当前放行两个来源：

| 来源 | 说明 |
|---|---|
| `<出口IP>` | Decodo 独享 ISP 代理，静态，本机 FlClash 全局出口（见第 8 节） |
| `<备用出口段>` | 机场节点出口段，FlClash 还原成订阅原样时走这里 |

**出口一旦不在名单内，面板会立刻打不开**，403 的响应体里会回显当前来源 IP。
不要手改 Caddyfile，用 `cpa-allow` 增删（它会自动校验并在失败时回滚）：

```bash
cpa-allow                    # 列出当前白名单
cpa-allow add 1.2.3.4        # 放行（支持 CIDR）
cpa-allow del 1.2.3.4        # 移除
```

脚本在 `/usr/local/bin/cpa-allow`，源码同步在 [`scripts/cpa-allow`](scripts/cpa-allow)。
它不允许把名单清空，否则谁都进不去。

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

### 5.6 浏览器里的旧面板会把你自己的 IP 封掉

症状是面板突然登不进，提示
`HTTP 403 ... IP banned due to too many failed attempts. Try again in NNmNNs`，
而密钥明明是对的。

成因：CPA 的中间件**先查 IP 封禁，再校验密钥**，所以封禁期间密钥正确与否根本不影响结果。
而封禁的来源是浏览器里残留的旧版面板标签页——它每 60 秒轮询一次
`/v0/management/capabilities`，这个接口在 v7.3.8 上已不存在，
页面里存的又是过期密钥，于是每分钟稳定贡献一次 401，攒够就封。
封禁到期后它继续轮询，几分钟内再封一次，形成死循环。

识别方法是看 `/opt/cliproxy/logs/main.log` 里 401 的时间戳是否精确间隔 60 秒：

```
22:51:22  401  <管理出口IP>  GET "/v0/management/capabilities"
22:52:21  401  <管理出口IP>  GET "/v0/management/capabilities"
```

注意 **IP 白名单救不了这个场景**，因为那个标签页和你共用同一个出口 IP。
真正的解法是 2.1 里那条 `handle /v0/management/capabilities`，
让请求到不了鉴权中间件。已封的状态用 `systemctl restart cliproxy` 清除（封禁表在内存里）。

客户端侧顺手清理：关掉全部相关标签页，硬刷新，必要时在 Console 执行 `localStorage.clear()`。

### 5.7 在面板上删掉重加账号，会把代理配置弄丢

面板上「删除 -> 重新添加」不是原地更新，而是生成一条**新的凭证**：
文件名换了 UUID 前缀，`proxy_url` 归零，账号悄无声息地退回机房 IP 直连，
既没有报错也没有任何提示。

2026-09-19 夜里三个账号被重加了一遍，直到第二天 17:08 才发现，
中间将近 18 小时全部在用服务器自己的 IP 出网，住宅代理等于白配。

```
codex-6ec0feca-bertakoeberlein26500   proxy_url: (空)
codex-7ec24ea0-AlannaGiudice360385    proxy_url: (空)
codex-b6702664-kaylynsession63115     proxy_url: (空)
```

对策是别在面板上加账号，改用第 7 节的 `cpa-account login` / `import`，
它们会自动把代理配好。已经踩了的话跑一次：

```bash
cpa-account doctor --fix
```

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

## 7. 服务器账号管理脚本 `cpa-account`

源码在本仓库 [`scripts/cpa-account.py`](scripts/cpa-account.py)，
装在服务器 `/usr/local/bin/cpa-account`（Python 3，无第三方依赖），
对接单实例 CPA 的管理接口 `127.0.0.1:8317/v0/management`。
**加账号不再需要打开面板**，而且会自动完成 5.7 里那一步容易漏掉的代理配置。

> 旧版本是对着 Home 集群写的，Home 停用后已失效，备份在
> `/usr/local/bin/cpa-account.home-version.bak`。

### 7.1 配置

`/etc/cliproxy/cpa-account.env`，权限 600：

```
MGMT_KEY=<管理密钥明文>
DECODO_USER=<Decodo 用户名>
DECODO_PASS=<Decodo 密码>
EXIT_IP=<出口IP>
EXIT_PORT=10001
```

脚本也能从任意一个已配好 `proxy_url` 的凭证里反推后四项，
但**账号被清空时就没有样本可推了**——2026-09-22 就因此让
`login` 的自动配代理步骤失败过。所以这四项现在固化在文件里，不再依赖反推。

注意 `config.yaml` 里的 `secret-key` 存的是 bcrypt 散列，**读不出明文**，
所以密钥必须单独放在这个文件里。

### 7.2 命令

| 命令 | 说明 |
|---|---|
| `list` | 列出账号：状态、出口 IP、成功/失败计数；缺代理的会标红 |
| `show <账号>` | 单个账号的完整字段（令牌和密码自动打码） |
| `doctor [--fix]` | 体检；`--fix` 自动补上缺失的代理。只残留历史错误、最近仍在成功的账号不算问题，单独列出备查 |
| `login` | Codex OAuth 登录，**完成后自动配代理并启用** |
| `import <文件.json>…` | 导入已有凭证，**同样自动配代理** |
| `quota` | 各账号配额窗口占用，并反推每周容量 |
| `proxy <账号\|all> [IP] [端口]` | 下发 Decodo 代理 |
| `proxy-url <账号\|all> <URL>` | 下发任意代理地址（Decodo 以外的供应商） |
| `weight <账号> <权重>` | 手动设加权轮询权重 |
| `rebalance` | 按套餐重算所有账号的权重 |
| `refresh <账号>` | 手动刷新令牌 |
| `enable` / `disable` / `delete` | 启用／停用／删除（删除需输入 yes） |

`<账号>` 填邮箱片段即可，能唯一匹配就行（`berta`、`kaylyn`）；
匹配到多个会列出候选并退出，不会误改。

### 7.3 两个实现上的选择

**下发代理走管理接口而不是直接改文件。** `PATCH /auth-files/fields`
由 CPA 自己落盘并增量热加载，不会出现 5.4 那种 inode 被换掉、
文件监听失效的问题。

**读 `proxy_url` 只能回磁盘。** `GET /auth-files` 的响应里不含这个字段
（返回的是 `status` / `unavailable` / `cooldowns` / `success` / `failed` 等），
所以 `list` 和 `doctor` 会额外读一次 `/opt/cliproxy/auths/*.json`。
这也是脚本必须在服务器本机、以 root 运行的原因。

### 7.4 日常用法

```bash
# 加新号：一条命令走完登录 -> 配代理 -> 启用
cpa-account login

# 怀疑有账号掉代理了（例如刚在面板上删了重加）
cpa-account doctor --fix

# 换出口
cpa-account proxy all <出口IP> 10001
```


### 7.5 加权轮询

`routing.strategy` 默认是 `round-robin`，**平均分配**。账号容量不同时，
容量小的会先被打到限额进冷却，剩下的号独自承压——表现为「额度不够导致单号压力过高」。

启用加权：

```yaml
# /opt/cliproxy/config.yaml —— 原地覆盖写，不要用 sed -i
routing:
  strategy: "weighted-round-robin"
```

**只设 `weight` 而不改 `strategy` 是无效的**，权重不会参与调度，且没有任何提示。
脚本的 `rebalance` 会检测这一点并告警。

权重按**实测容量**定，不按套餐名义档次。用 `cpa-account quota` 看：
它用「累计请求数 ÷ 已消耗的周配额百分比」反推每周满额次数。

一次实测（2026-09-23）：

| 账号 | 套餐 | 推算周容量 |
|---|---|---|
| A | pro | ≈ 20,750 次 |
| B | plus | ≈ 9,251 次 |
| C | plus | ≈ 8,170 次 |

比值约 **2.3 : 1**，所以默认权重是 `pro 2 / plus 1`。
两个 Plus 独立算出 9,251 和 8,170，相差 10% 以内，互相印证。

> 注意别把 Pro 的权重拍得过高（例如 20）。那会把 Pro 一周内打爆、Plus 闲置，
> 问题只是换了个受害者，而且换成更贵的那个。

新账号通过 `login` / `import` 加入时会**自动按套餐定权重**。
套餐优先取配额信号里的 `X-Codex-Plan-Type`；新号还没发过请求时信号为空，
退回到文件名后缀（`...-pro.json` / `...-plus.json`）。

需要覆盖默认值时，在 `/etc/cliproxy/cpa-account.env` 里加：

```
WEIGHT_PRO=3
WEIGHT_PLUS=1
```

另外注意两种套餐的**瓶颈窗口不同**：Plus 卡在 5 小时窗口（这是它频繁冷却的直接原因），
Pro 的主窗口是 168 小时。加权只能摊匀负载，**创造不出额度**——
总需求超过三号容量之和时，怎么配都会限流。

## 8. 本机 FlClash 套住宅出口 `flclash-decodo.py`

装在 `~/bin/flclash-decodo.py`，源码同步在 [`scripts/flclash-decodo.py`](scripts/flclash-decodo.py)。
作用是让本机的境外流量和服务器上各账号走同一个 Decodo 出口 <出口IP>，
使浏览器登录 IP 与 API 请求 IP 保持一致。

```bash
flclash-decodo.py            # 套上并重启 FlClash
flclash-decodo.py --check    # 只看状态
flclash-decodo.py --revert   # 还原成订阅原样
```

### 8.1 为什么不能用 FlClash 自带的「覆写」

覆写表（`database.sqlite` 的 `proxy_groups` / `rules`）**只支持代理组和规则，
没有存放自定义节点的地方**，而 Decodo 是一个 socks5 节点。所以只能改订阅文件
`profiles/<id>.yaml` 本身。

### 8.2 订阅自动更新会把改动整个冲掉

该订阅原本是 **每 10 分钟**自动更新一次
（`profiles.auto_update=1`、`auto_update_duration_millis=600000`），
拉取后直接覆盖整个 yaml，手改内容连同节点一起消失，**没有任何提示**。
症状是「刚才还好好的，过一会儿又变回机房 IP」。

脚本会把 `auto_update` 置 0。代价是订阅不再自动刷新，
手动更新过订阅之后要重跑一次脚本。

### 8.3 链路结构

```
本机 → 中转(url-test 自动选最快) → isp.decodo.com:10001 → 出口 <出口IP> → 目标站点
```

`dialer-proxy` 不能指向 `PROXY`：规则目标已整体改为 `住宅IP`，
再指回 `PROXY` 会变成自己套自己的死循环，所以另建了一个 `中转` 组。
`中转` 用 `url-test` 而非 `select`，避免机场改动节点名时断链。

国内流量不受影响——`GEOIP,CN,DIRECT` 等 123 条直连规则保持原样。

### 8.4 实测代价

| 指标 | 直连订阅节点 | 加住宅出口 |
|---|---|---|
| TLS 握手 | 约 0.32s | 约 1.3s |
| 下载吞吐 | — | 约 21 Mbps |

慢的原因是 Decodo 的入口网关在香港（149.102.253.x），出口在日本，绕了一圈。

### 8.5 出口 IP 的真实属性

`<出口IP>` 属于 **AS3356 Level 3（Lumen，一级骨干运营商）**，
不是 NTT/KDDI/SoftBank 这类家宽 ISP。Decodo 卖的 ISP 代理就是这个形态：
托管在机房、IP 注册在运营商 ASN 下。比纯机房 IP 干净，但不是真住宅。
原订阅节点 `<备用出口段>` 属 AS32135 SAKURA，在 IPPure 上是 82% 极度风险。


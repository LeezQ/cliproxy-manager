#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cpa-account —— CLIProxyAPI 单实例账号管理工具

解决的问题
----------
在面板上删除再重新添加账号会分配新的凭证 ID，`proxy_url` 随之被清空，
账号会悄无声息地退回机房 IP 直连。这个脚本把「加账号 -> 配代理 -> 启用」
收敛成一条命令，并提供 doctor 体检随时把漏配的账号捞出来修好。

运行位置
--------
服务器本机（需要读 /opt/cliproxy/auths/ 下的凭证文件），以 root 运行。

配置文件
--------
/etc/cliproxy/cpa-account.env，权限 600，内容形如：

    MGMT_KEY=<管理密钥明文>
    DECODO_USER=<Decodo 用户名>
    DECODO_PASS=<Decodo 密码>
    EXIT_IP=<出口IP>
    EXIT_PORT=10001

其中 DECODO_* 与 EXIT_* 若缺失，会自动从现有凭证的 proxy_url 里反推，
所以正常情况下只需要填 MGMT_KEY 一项。

质量检测（probe / quality）另有两个可选项：

    QUALITY_MODEL=gpt-5.6-sol     测试用的模型
    QUALITY_EFFORT=high           推理强度 low / medium / high / xhigh
"""

import json
import os
import re
import sys
import glob
import time
import uuid
import tempfile
import threading
import statistics
import subprocess
import urllib.parse
import urllib.request
import urllib.error
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

# ---------------------------------------------------------------- 常量

ENV_FILE = "/etc/cliproxy/cpa-account.env"
AUTH_DIR = "/opt/cliproxy/auths"
API_BASE = "http://127.0.0.1:8317/v0/management"
PROXY_GATEWAY = "isp.decodo.com"

# 输出不是终端（定时任务写 journal、管道重定向）或设置了 NO_COLOR 时不上色，
# 否则日志里会混入 ANSI 转义序列
if sys.stdout.isatty() and not os.environ.get("NO_COLOR"):
    C_RESET, C_DIM, C_RED, C_GREEN, C_YELLOW, C_BOLD = (
        "\033[0m", "\033[2m", "\033[31m", "\033[32m", "\033[33m", "\033[1m"
    )
else:
    C_RESET = C_DIM = C_RED = C_GREEN = C_YELLOW = C_BOLD = ""


def log_error(msg, exc=None):
    """统一的错误输出。异常一律带上类型和内容，便于事后排查。"""
    detail = f" | {type(exc).__name__}: {exc}" if exc is not None else ""
    print(f"{C_RED}[错误]{C_RESET} {msg}{detail}", file=sys.stderr)


def die(msg, exc=None):
    log_error(msg, exc)
    sys.exit(1)


# ---------------------------------------------------------------- 配置

def load_env():
    """读取配置文件；缺失的代理参数从现有凭证反推，避免重复录入密码。"""
    env = {}
    if os.path.exists(ENV_FILE):
        try:
            with open(ENV_FILE, encoding="utf-8") as fh:
                for line in fh:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
        except Exception as e:
            die(f"读取配置文件失败: {ENV_FILE}", e)

    if not env.get("MGMT_KEY"):
        die(
            f"缺少管理密钥。请创建 {ENV_FILE}，写入一行：\n"
            f"  MGMT_KEY=<你的管理密钥>\n"
            f"然后 chmod 600 {ENV_FILE}"
        )

    # 代理参数缺失时，从任意一个已配好代理的凭证里反推出来
    if not all(env.get(k) for k in ("DECODO_USER", "DECODO_PASS", "EXIT_IP", "EXIT_PORT")):
        derived = derive_proxy_parts()
        for k, v in derived.items():
            env.setdefault(k, v)

    return env


def derive_proxy_parts():
    """
    从磁盘上任意一个仍带 proxy_url 的凭证里拆出代理各部分。
    格式：socks5h://user-<用户名>-ip-<出口IP>:<密码>@isp.decodo.com:<端口>
    """
    for path in sorted(glob.glob(f"{AUTH_DIR}/*.json")):
        try:
            with open(path, encoding="utf-8") as fh:
                url = (json.load(fh) or {}).get("proxy_url") or ""
        except Exception as e:
            log_error(f"解析凭证失败，已跳过: {os.path.basename(path)}", e)
            continue
        if "-ip-" not in url or "@" not in url:
            continue
        try:
            head, tail = url.split("@", 1)
            _, cred = head.split("://", 1)
            userpart, password = cred.split(":", 1)
            user = userpart.split("-ip-")[0].removeprefix("user-")
            exit_ip = userpart.split("-ip-")[1]
            port = tail.rsplit(":", 1)[1]
            return {
                "DECODO_USER": user,
                "DECODO_PASS": password,
                "EXIT_IP": exit_ip,
                "EXIT_PORT": port,
            }
        except Exception as e:
            log_error(f"反推代理参数失败: {os.path.basename(path)}", e)
    return {}


def build_proxy_url(env, exit_ip=None, port=None):
    """按 Decodo「用户名锁定出口 IP」的写法拼装代理地址。"""
    user = env.get("DECODO_USER")
    password = env.get("DECODO_PASS")
    exit_ip = exit_ip or env.get("EXIT_IP")
    port = port or env.get("EXIT_PORT")
    if not all([user, password, exit_ip, port]):
        # 这里不直接退出：login 流程后面还有「启用账号」等步骤，
        # 代理配不上不该连账号都不启用。交给调用方降级处理。
        raise RuntimeError(
            f"代理参数不全，且无法从现有凭证反推。"
            f"请在 {ENV_FILE} 里补齐 DECODO_USER / DECODO_PASS / EXIT_IP / EXIT_PORT"
        )
    return f"socks5h://user-{user}-ip-{exit_ip}:{password}@{PROXY_GATEWAY}:{port}"


# ---------------------------------------------------------------- HTTP

def api(method, path, body=None, params=None, timeout=60):
    """调用 CPA 管理接口。非 2xx 一律抛出，由调用方决定如何处理。"""
    env = CONFIG
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)

    data = None
    headers = {"Authorization": f"Bearer {env['MGMT_KEY']}"}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8") or "{}"
        return json.loads(raw) if raw.strip().startswith(("{", "[")) else raw
    except urllib.error.HTTPError as e:
        detail = ""
        try:
            detail = e.read().decode("utf-8")[:300]
        except Exception:
            pass
        log_error(f"{method} {path} 返回 HTTP {e.code}", None)
        if detail:
            print(f"       {detail}", file=sys.stderr)
        raise
    except Exception as e:
        log_error(f"{method} {path} 请求失败", e)
        raise


def list_files():
    """列出全部凭证，并从磁盘补上 API 不返回的 proxy_url 字段。"""
    try:
        data = api("GET", "/auth-files")
    except Exception:
        die("无法读取账号列表，检查 cliproxy 是否在运行、MGMT_KEY 是否正确")

    files = data.get("files", []) if isinstance(data, dict) else []
    for f in files:
        f["proxy_url"] = read_proxy_from_disk(f.get("path") or "")
    return files


def read_proxy_from_disk(path):
    """管理接口不返回 proxy_url，只能回到磁盘上读。"""
    if not path or not os.path.exists(path):
        return ""
    try:
        with open(path, encoding="utf-8") as fh:
            return (json.load(fh) or {}).get("proxy_url") or ""
    except Exception as e:
        log_error(f"读取 proxy_url 失败: {os.path.basename(path)}", e)
        return ""


def exit_ip_of(proxy_url):
    """
    从代理地址里取出出口 IP，不回显密码。
    Decodo 用「用户名锁定出口」的写法，真正的出口在用户名里；
    其他供应商则是普通的 host:port，取 host 即可。
    """
    if not proxy_url:
        return ""
    head = proxy_url.split("@")[0]
    if "-ip-" in head:
        return head.split("-ip-")[1].split(":")[0]
    host = proxy_url.split("@")[-1]
    return host.rsplit(":", 1)[0] if ":" in host else host


def resolve(query):
    """把用户输入的片段解析成唯一的一条凭证。匹配不到或有歧义都直接退出。"""
    files = list_files()
    q = query.lower()
    hits = [
        f for f in files
        if q in (f.get("email") or "").lower()
        or q in (f.get("name") or "").lower()
        or q == (f.get("id") or "").lower()
    ]
    if not hits:
        die(f"没有匹配到账号: {query}")
    if len(hits) > 1:
        log_error(f"「{query}」匹配到多个账号，请写得更具体：")
        for h in hits:
            print(f"       {h.get('email')}", file=sys.stderr)
        sys.exit(1)
    return hits[0]


# ---------------------------------------------------------------- 展示

# 判定「最近仍在成功出请求」所看的分桶数。
# recent_requests 每桶 10 分钟、按时间从旧到新，取末尾 3 桶即最近 30 分钟。
# 与面板（cliproxy-manager 的 isStaleAuthFileError）保持同一口径。
RECENT_SUCCESS_BUCKETS = 3


def has_recent_success(f):
    """最近 30 分钟内是否有过成功请求。"""
    buckets = f.get("recent_requests") or []
    for b in buckets[-RECENT_SUCCESS_BUCKETS:]:
        try:
            if int(b.get("success") or 0) > 0:
                return True
        except (TypeError, ValueError, AttributeError) as e:
            log_error("recent_requests 分桶格式异常，已忽略", e)
    return False


def has_error_status(f):
    return str(f.get("status") or "").strip().lower() == "error"


def is_stale_error(f):
    """
    status 停在 error 只是历史残留，实际仍在正常工作。

    背景：CPA 按模型记错误、按账号汇总状态。冷门模型撞一次临时错误（如
    server_is_overloaded）后若再没请求分到它，该模型的错误不会清除，账号
    status 就一直是 error，即便主力模型持续成功。
    """
    return (not f.get("unavailable")) and has_error_status(f) and has_recent_success(f)


def state_of(f):
    """把若干个字段归纳成一个人看得懂的状态。"""
    if f.get("disabled"):
        return "已停用", C_DIM
    if f.get("unavailable"):
        return "不可用", C_RED
    if f.get("cooldowns"):
        return "冷却中", C_YELLOW
    # status=error 且最近没有任何成功：这才是真在出错，而不是历史残留
    if has_error_status(f) and not has_recent_success(f):
        return "异常", C_RED
    return "正常", C_GREEN


def width(s):
    """按终端显示宽度计算，中日韩字符占两格，保证表格能对齐。"""
    return sum(2 if ord(c) > 0x2E80 else 1 for c in str(s))


def pad(s, n):
    return str(s) + " " * max(0, n - width(s))


def exit_pool(env):
    """
    可用出口列表。配置文件里用 EXIT_POOL 写成逗号分隔，
    没配就退回单个 EXIT_IP（行为与旧版一致）。
    """
    raw = (env.get("EXIT_POOL") or "").strip()
    if raw:
        pool = [x.strip() for x in raw.split(",") if x.strip()]
        if pool:
            return pool
    ip = env.get("EXIT_IP")
    return [ip] if ip else []


def pick_exit(env, files=None, exclude_name=None):
    """
    挑一个当前占用最少的出口。
    目的是让「一号一 IP」尽量成立——出口不够时也均摊，而不是全堆在默认那个上。

    exclude_name: 正在被分配的那个账号，统计占用时要把它自己排除掉，
    否则给同一个号重新分配时会把它当前的出口误判成「已占用」而换到别处。
    """
    pool = exit_pool(env)
    if not pool:
        return None
    if files is None:
        files = list_files()
    used = {ip: 0 for ip in pool}
    for f in files:
        if exclude_name and f.get("name") == exclude_name:
            continue
        u = f.get("proxy_url") or ""
        if "-ip-" in u:
            ip = u.split("@")[0].split("-ip-")[-1].split(":")[0]
            if ip in used:
                used[ip] += 1
    # 占用数相同时按 pool 里的顺序取，保证结果可预测
    return min(pool, key=lambda ip: (used[ip], pool.index(ip)))


def cmd_list(_args):
    files = list_files()
    if not files:
        print("（没有账号）")
        return

    cols = [("邮箱", 36), ("套餐", 6), ("权重", 6),
            ("状态", 8), ("出口 IP", 17), ("成功/失败", 11)]
    header = " ".join(pad(t, w) for t, w in cols)
    print(f"{C_BOLD}{header}{C_RESET}")
    print("-" * width(header))

    for f in files:
        state, color = state_of(f)
        proxy = exit_ip_of(f.get("proxy_url"))
        plan = plan_of(f) or "?"
        w = f.get("weight")

        # 上色一律在补齐宽度之后做，否则 ANSI 转义序列会被算进列宽，表格会歪
        proxy_cell = pad(proxy or "直连(缺代理)", cols[4][1])
        if not proxy:
            proxy_cell = f"{C_RED}{proxy_cell}{C_RESET}"

        # 权重为空表示从未设过，此时不参与容量分配，标黄提示
        w_cell = pad("未设" if w is None else str(w), cols[2][1])
        if w is None:
            w_cell = f"{C_YELLOW}{w_cell}{C_RESET}"

        print(
            f"{pad((f.get('email') or '?')[:34], cols[0][1])} "
            f"{pad(plan, cols[1][1])} "
            f"{w_cell} "
            f"{color}{pad(state, cols[3][1])}{C_RESET} "
            f"{proxy_cell} "
            f"{pad(f"{f.get('success', 0)}/{f.get('failed', 0)}", cols[5][1])}"
        )

    missing = [f for f in files if not f.get("proxy_url") and not f.get("disabled")]
    noweight = [f for f in files if f.get("weight") is None and not f.get("disabled")]
    stale = [f for f in files if not f.get("disabled") and is_stale_error(f)]
    if stale:
        print()
        print(f"{C_DIM}ⓘ {len(stale)} 个账号残留历史错误但仍在正常工作，"
              f"详情见 `cpa-account doctor`{C_RESET}")
    if missing or noweight:
        print()
    if missing:
        print(f"{C_YELLOW}⚠ {len(missing)} 个启用中的账号没有代理，"
              f"跑 `cpa-account doctor --fix` 修复{C_RESET}")
    if noweight:
        print(f"{C_YELLOW}⚠ {len(noweight)} 个账号没有权重，"
              f"跑 `cpa-account rebalance` 按套餐补上{C_RESET}")


def cmd_show(args):
    if not args:
        die("用法: cpa-account show <账号>")
    f = resolve(args[0])
    for k in sorted(f.keys()):
        v = f[k]
        if k == "proxy_url" and v:
            v = f"socks5h://***@{PROXY_GATEWAY}:{v.rsplit(':', 1)[-1]}  (出口 {exit_ip_of(v)})"
        elif any(t in k.lower() for t in ("token", "secret", "key")):
            v = "***"
        print(f"  {pad(k, 18)} {str(v)[:140]}")


# ---------------------------------------------------------------- 操作

def apply_proxy(f, env, exit_ip=None, port=None, quiet=False):
    """给单个账号下发代理。走管理接口而不是直接改文件，避免 inode 变化导致监听失效。"""
    name = f.get("name")
    if not exit_ip:
        # 没指定就挑占用最少的出口，而不是一律用默认那个
        exit_ip = pick_exit(env, exclude_name=name)
    try:
        url = build_proxy_url(env, exit_ip, port)
    except Exception as e:
        log_error(f"无法为 {f.get('email')} 生成代理地址", e)
        print(f"       补好配置后执行: cpa-account proxy {f.get('email')}", file=sys.stderr)
        return False
    try:
        api("PATCH", "/auth-files/fields", {"name": name, "proxy_url": url})
    except Exception:
        log_error(f"下发代理失败: {f.get('email')}")
        return False
    if not quiet:
        print(f"  {C_GREEN}✓{C_RESET} {f.get('email')} 出口 -> {exit_ip or env['EXIT_IP']}:{port or env['EXIT_PORT']}")
    return True


def cmd_proxy(args):
    if not args:
        die("用法: cpa-account proxy <账号|all> [出口IP] [端口]")
    exit_ip = args[1] if len(args) > 1 else None
    port = args[2] if len(args) > 2 else None

    targets = list_files() if args[0] == "all" else [resolve(args[0])]
    ok = sum(apply_proxy(f, CONFIG, exit_ip, port) for f in targets)
    print(f"\n完成 {ok}/{len(targets)}")


def cmd_proxy_url(args):
    """
    直接下发一条完整的代理地址，不做任何拼装。
    用于 Decodo 以外的供应商——它们多是普通的 user:pass@host:port 形式。

    支持 socks5 / socks5h / http / https。
    强烈建议用 socks5h：域名交给代理端解析，避免本地 DNS 泄漏真实位置。
    """
    if len(args) < 2:
        die("用法: cpa-account proxy-url <账号|all> <完整代理URL>\n"
            "  例: cpa-account proxy-url berta 'socks5h://user:pass@1.2.3.4:1080'")

    url = args[1]
    scheme = url.split("://", 1)[0].lower() if "://" in url else ""
    if scheme not in ("socks5", "socks5h", "http", "https"):
        die(f"不支持的协议: {scheme or url[:20]}（只支持 socks5/socks5h/http/https）")
    if scheme == "socks5":
        log_error("提示: 用 socks5h 而不是 socks5，否则域名在本地解析，会泄漏真实位置")

    targets = list_files() if args[0] == "all" else [resolve(args[0])]
    ok = 0
    for f in targets:
        try:
            api("PATCH", "/auth-files/fields", {"name": f["name"], "proxy_url": url})
        except Exception:
            log_error(f"下发失败: {f.get('email')}")
            continue
        host = url.split("@")[-1]
        print(f"  {C_GREEN}✓{C_RESET} {f.get('email')} -> {scheme}://***@{host}")
        ok += 1
    print(f"\n完成 {ok}/{len(targets)}")
    if ok:
        print()
        cmd_list([])


def cmd_weight(args):
    """
    设置加权轮询的权重。

    前提：config.yaml 里 routing.strategy 必须是 weighted-round-robin，
    否则权重写进去也不参与调度（默认是 round-robin，平均分配）。

    取值：整数，默认 1；<= 0 表示不参与加权调度；上限 1,000,000。
    合理的比例应当按各账号的**实际配额容量**来定，不是按套餐名义档次。
    用 `cpa-account quota` 看每个号的窗口占用，反推容量。
    """
    if len(args) < 2:
        die("用法: cpa-account weight <账号> <权重>\n"
            "  例: cpa-account weight bn2bv2by89 2")
    try:
        w = int(args[1])
    except ValueError as e:
        die(f"权重必须是整数: {args[1]}", e)
    if w > 1_000_000:
        die("权重不能超过 1,000,000")

    f = resolve(args[0])
    try:
        api("PATCH", "/auth-files/fields", {"name": f["name"], "weight": w})
    except Exception:
        die(f"设置权重失败: {f.get('email')}")
    note = "（<=0，不参与加权调度）" if w <= 0 else ""
    print(f"  {C_GREEN}✓{C_RESET} {f.get('email')} weight = {w} {note}")


def cmd_quota(_args):
    """按配额窗口展示各账号的余量，并反推每周容量，用来决定权重。"""
    files = list_files()
    if not files:
        print("（没有账号）")
        return
    for f in files:
        sig = (f.get("quota") or {}).get("signals") or {}
        if not sig:
            print(f"  {(f.get('email') or '?')[:40]}  （暂无配额信号，发一次请求后才有）")
            continue

        def num(k):
            try:
                return float(sig.get(k) or 0)
            except (TypeError, ValueError):
                return 0.0

        plan = sig.get("X-Codex-Plan-Type", "?")
        pw, pu = num("X-Codex-Primary-Window-Minutes"), num("X-Codex-Primary-Used-Percent")
        sw, su = num("X-Codex-Secondary-Window-Minutes"), num("X-Codex-Secondary-Used-Percent")
        ok = f.get("success") or 0

        print(f"  {C_BOLD}{(f.get('email') or '?')[:40]}{C_RESET}  [{plan}]  weight={f.get('weight')}")
        print(f"     主窗口 {pw/60:6.1f}h  已用 {pu:5.1f}%"
              f"   {num('X-Codex-Primary-Reset-After-Seconds')/3600:5.1f}h 后重置")
        if sw:
            print(f"     次窗口 {sw/60:6.1f}h  已用 {su:5.1f}%"
                  f"   {num('X-Codex-Secondary-Reset-After-Seconds')/3600:5.1f}h 后重置")
        # 用「每次请求消耗多少周配额」反推容量；周窗口可能落在主窗口或次窗口
        weekly = su if sw >= 10000 else (pu if pw >= 10000 else 0)
        if weekly > 0 and ok > 0:
            print(f"     推算周容量 ≈ {int(ok / weekly * 100):,} 次"
                  f"（基于 {ok} 次请求消耗 {weekly:.0f}% 周配额）")
        print()


# 套餐 -> 加权轮询权重。
# 数值依据实测容量（用「累计请求数 ÷ 已消耗周配额百分比」反推）：
#   Pro  约 20,000 次/周     Plus 约 8,500 次/周     比值 ≈ 2.3
# 不是按套餐名义档次拍脑袋。可在 cpa-account.env 里用 WEIGHT_PRO / WEIGHT_PLUS 覆盖。
# 整体放大 10 倍，是为了让 free 能表达成「远低于 plus」——
# 权重必须是正整数，<=0 会被排除出调度，所以 plus 不能停在 1。
# pro:plus = 20:10 仍是实测的 2.3:1；free 暂定 1，等它跑出配额数据再用
# `cpa-account quota` 反推真实容量后调整。
DEFAULT_WEIGHTS = {"pro": 20, "plus": 10, "team": 20, "business": 20, "free": 1}


def plan_of(f):
    """
    判断账号套餐。
    优先用配额信号里的 X-Codex-Plan-Type；新账号还没发过请求时信号是空的，
    退回到文件名后缀（CPA 落盘时会写成 ...-pro.json / ...-plus.json）。
    """
    sig = (f.get("quota") or {}).get("signals") or {}
    plan = (sig.get("X-Codex-Plan-Type") or "").strip().lower()
    if plan:
        return plan
    name = (f.get("name") or "").lower()
    for p in DEFAULT_WEIGHTS:
        if name.endswith(f"-{p}.json"):
            return p
    return ""


def weight_for(plan, env):
    """取该套餐应有的权重，允许在配置文件里覆盖。"""
    if not plan:
        return None
    key = f"WEIGHT_{plan.upper()}"
    raw = env.get(key)
    if raw:
        try:
            return int(raw)
        except ValueError as e:
            log_error(f"{ENV_FILE} 里 {key}={raw} 不是整数，改用默认值", e)
    return DEFAULT_WEIGHTS.get(plan)


def apply_auto_weight(f, env, quiet=False):
    """按套餐给单个账号设权重。已经是目标值就跳过，避免无谓的写入。"""
    plan = plan_of(f)
    want = weight_for(plan, env)
    if want is None:
        if not quiet:
            log_error(f"无法判断套餐，跳过权重: {f.get('email')}"
                      f"（发一次请求后再跑 cpa-account rebalance）")
        return False
    if f.get("weight") == want:
        if not quiet:
            print(f"  = {f.get('email')} 已是 weight {want}（{plan}）")
        return True
    try:
        api("PATCH", "/auth-files/fields", {"name": f["name"], "weight": want})
    except Exception:
        log_error(f"设置权重失败: {f.get('email')}")
        return False
    if not quiet:
        print(f"  {C_GREEN}✓{C_RESET} {f.get('email')} weight {f.get('weight')} -> {want}（{plan}）")
    return True


def warn_if_not_weighted():
    """
    权重只有在 routing.strategy = weighted-round-robin 时才参与调度。
    默认是 round-robin，此时设了也白设，所以主动提醒一次。
    """
    try:
        cfg = api("GET", "/config")
    except Exception:
        return
    strat = ""
    if isinstance(cfg, dict):
        r = cfg.get("routing") or {}
        strat = (r.get("strategy") if isinstance(r, dict) else "") or ""
    if strat and strat != "weighted-round-robin":
        log_error(f"当前 routing.strategy = {strat}，权重不参与调度。"
                  f"改成 weighted-round-robin 才会生效。")


def cmd_rebalance(args):
    """按套餐重算所有账号的权重。"""
    warn_if_not_weighted()
    files = list_files()
    if not files:
        print("（没有账号）")
        return
    print("按套餐重算权重：")
    ok = sum(apply_auto_weight(f, CONFIG) for f in files)
    print(f"\n完成 {ok}/{len(files)}")
    print()
    cmd_quota([])


def cmd_doctor(args):
    """体检：把所有「启用但没代理」的账号找出来，带 --fix 就顺手修好。"""
    fix = "--fix" in args
    files = list_files()

    problems = []
    for f in files:
        if f.get("disabled"):
            continue
        if not f.get("proxy_url"):
            problems.append((f, "缺少代理，正在用机房 IP 直连"))
        elif f.get("unavailable"):
            problems.append((f, f"不可用: {f.get('status_message') or '令牌可能已失效'}"))
        elif f.get("cooldowns"):
            problems.append((f, "冷却中，上游最近拒绝过它"))
        elif has_error_status(f) and not has_recent_success(f):
            problems.append((f, f"最近 30 分钟没有成功请求，最后错误: "
                                f"{(f.get('status_message') or '未知')[:120]}"))

    # 历史残留不算问题，但列出来备查，免得和面板上的旧错误对不上
    stale = [f for f in files if not f.get("disabled") and is_stale_error(f)]

    if not problems:
        print(f"{C_GREEN}✓ 全部正常{C_RESET}（{len(files)} 个账号）")
        if stale:
            print(f"\n{C_DIM}以下账号残留历史错误，但最近仍在成功出请求，无需处理：{C_RESET}")
            for f in stale:
                print(f"{C_DIM}  {f.get('email')}\n      {(f.get('status_message') or '')[:120]}{C_RESET}")
        return

    print(f"{C_YELLOW}发现 {len(problems)} 个问题：{C_RESET}\n")
    for f, why in problems:
        print(f"  {f.get('email')}\n      {why}")
    print()

    if not fix:
        print("加 --fix 自动修复其中「缺少代理」的部分：")
        print("  cpa-account doctor --fix")
        return

    repairable = [f for f, why in problems if why.startswith("缺少代理")]
    if not repairable:
        print("没有可以自动修复的项。令牌失效需要重新登录：cpa-account login")
        return

    print("正在补代理：")
    ok = sum(apply_proxy(f, CONFIG) for f in repairable)
    print(f"\n完成 {ok}/{len(repairable)}")


def cmd_state(args, disabled):
    if not args:
        die(f"用法: cpa-account {'disable' if disabled else 'enable'} <账号>")
    f = resolve(args[0])
    try:
        api("PATCH", "/auth-files/status", {"name": f["name"], "disabled": disabled})
    except Exception:
        die(f"设置状态失败: {f.get('email')}")
    print(f"{C_GREEN}✓{C_RESET} 已{'停用' if disabled else '启用'} {f.get('email')}")


def cmd_refresh(args):
    if not args:
        die("用法: cpa-account refresh <账号>")
    f = resolve(args[0])
    try:
        api("POST", "/auth-files/refresh", {"name": f["name"]})
    except Exception:
        die(f"刷新失败: {f.get('email')}。若提示令牌已失效，需要重新登录")
    print(f"{C_GREEN}✓{C_RESET} 已请求刷新 {f.get('email')}")


def cmd_delete(args):
    if not args:
        die("用法: cpa-account delete <账号>")
    f = resolve(args[0])
    print(f"即将删除：{f.get('email')}")
    if input("确认？(yes/N) ").strip().lower() != "yes":
        print("已取消")
        return
    try:
        api("DELETE", "/auth-files", {"names": [f["name"]]})
    except Exception:
        die(f"删除失败: {f.get('email')}")
    print(f"{C_GREEN}✓{C_RESET} 已删除 {f.get('email')}")


def cmd_login(_args):
    """
    Codex OAuth 登录。完成后自动给新账号配好代理——
    这一步正是在面板上手工操作时最容易漏掉的。
    """
    before = {f["name"] for f in list_files()}

    try:
        resp = api("GET", "/codex-auth-url", params={"is_webui": "true"})
    except Exception:
        die("获取授权链接失败")

    url, state = resp.get("url"), resp.get("state")
    if not url:
        die(f"返回里没有授权链接: {json.dumps(resp, ensure_ascii=False)[:200]}")

    print("\n1) 在浏览器里打开下面的链接，用要添加的账号登录：\n")
    print(f"   {C_BOLD}{url}{C_RESET}\n")
    print("2) 登录完成后浏览器会跳到一个打不开的 localhost 地址，")
    print("   这是正常的。把地址栏里的完整 URL 复制下来粘贴到这里。\n")

    redirect = input("   回调 URL（直接回车 = 已在浏览器内完成，跳过）: ").strip()
    if redirect:
        try:
            api("POST", "/oauth-callback", {"provider": "codex", "redirect_url": redirect})
        except Exception:
            die("提交回调失败，确认粘贴的是完整 URL（含 code 参数）")

    # 等待后端把凭证落盘
    print("\n等待凭证入库...")
    new = []
    for _ in range(30):
        time.sleep(2)
        if state:
            try:
                st = api("GET", "/get-auth-status", params={"state": state})
                if isinstance(st, dict) and st.get("status") == "error":
                    die(f"授权失败: {st.get('error')}")
            except Exception:
                pass  # 状态查询失败不致命，继续靠文件差异判断
        new = [f for f in list_files() if f["name"] not in before]
        if new:
            break

    if not new:
        log_error("没有检测到新账号。若你是在浏览器里自行完成的，稍后跑 `cpa-account doctor --fix` 补代理")
        return

    print(f"\n{C_GREEN}✓{C_RESET} 新增 {len(new)} 个账号，正在自动配置代理：")
    proxy_failed = 0
    for f in new:
        if not apply_proxy(f, CONFIG):
            proxy_failed += 1
        # 代理失败也要继续启用，账号本身是可用的
        try:
            api("PATCH", "/auth-files/status", {"name": f["name"], "disabled": False})
        except Exception:
            log_error(f"启用失败，请手动执行 cpa-account enable {f.get('email')}")
        # 按套餐自动定权重，避免新号以默认权重 1 参与调度导致容量分配失衡
        apply_auto_weight(f, CONFIG)
    if proxy_failed:
        log_error(f"{proxy_failed} 个账号未配上代理，正在用机房 IP 直连，"
                  f"修好后跑 cpa-account doctor --fix")
    print()
    cmd_list([])


def cmd_import(args):
    """上传已有的凭证 JSON，上传完同样自动配代理。"""
    if not args:
        die("用法: cpa-account import <文件.json> [...]")

    before = {f["name"] for f in list_files()}

    # 管理接口收的是 multipart，标准库拼起来麻烦，直接落盘更稳，
    # CPA 的目录监听会自动增量加载。
    import shutil
    for src in args:
        if not os.path.exists(src):
            log_error(f"文件不存在，已跳过: {src}")
            continue
        dst = os.path.join(AUTH_DIR, os.path.basename(src))
        try:
            shutil.copyfile(src, dst)          # 复制内容而非改名，保持 inode 语义
            os.chown(dst, *owner_of(AUTH_DIR))
            os.chmod(dst, 0o600)
            print(f"  已放入 {os.path.basename(dst)}")
        except Exception as e:
            log_error(f"导入失败: {src}", e)

    time.sleep(3)
    new = [f for f in list_files() if f["name"] not in before]
    if not new:
        log_error("没有检测到新账号，确认文件格式是否正确")
        return

    print(f"\n{C_GREEN}✓{C_RESET} 新增 {len(new)} 个账号，正在自动配置代理和权重：")
    for f in new:
        apply_proxy(f, CONFIG)
        apply_auto_weight(f, CONFIG)
    print()
    cmd_list([])


# ---------------------------------------------------------------- 质量检测（降智）
#
# 目的：把「哪个号、什么时候被降智」变成可查的记录，而不是凭手感。
#
# 做法：给每个账号单独发一道固定的逻辑题（社区通用的糖果题，正确答案 21），
# 记录答对与否和推理 token 数，追加写入 QUALITY_LOG。未降智的模型只要开思考
# 就能答对；降智时推理 token 会被卡在 516 左右，答案多为 29。
# 参考：router-for-me/CLIProxyAPI#3936、ranxi2001/sub2api 的「降智运维」。
#
# 为什么不走 CPA 的 /v0/management/api-call：
#   该接口把单次请求写死为 60 秒超时，高推理强度下未降智的回答常常超过 60 秒，
#   反而会被误记为失败。这里直接用 curl 请求上游，超时由 PROBE_TIMEOUT 决定。
#
# 安全边界：
#   - 只读取凭证文件里的 access_token，绝不刷新令牌。刷新仍然只有 CPA 一处在做，
#     不会出现两处同时刷新导致 refresh token 被吊销。
#   - 请求走该账号自己的 proxy_url，出口与 CPA 实际转发时一致。
#   - 令牌和代理密码通过 stdin 传给 curl，不出现在进程列表里。

QUALITY_LOG = "/var/lib/cliproxy/quality.jsonl"
CODEX_RESPONSES_URL = "https://chatgpt.com/backend-api/codex/responses"
# 单次测试的超时（秒）。高推理强度的正常回答可能要几分钟，给足余量。
PROBE_TIMEOUT = 900
DEFAULT_QUALITY_MODEL = "gpt-5.6-sol"
DEFAULT_QUALITY_EFFORT = "high"
# 与 CPA 转发 Codex 请求时伪装的客户端标识一致，测到的才是账号在 CPA 路径上的真实表现
PROBE_USER_AGENT = "codex-tui/0.154.0 (Mac OS 26.5.2; arm64) iTerm.app/3.6.11 (codex-tui; 0.154.0)"
PROBE_ORIGINATOR = "codex-tui"
# 社区观察到的降智特征值：被限制时 reasoning_tokens 恰好停在 516
DEGRADED_REASONING_MARK = 516

CANDY_PROMPT = """在一个黑色的袋子里放有三种口味的糖果，每种糖果有两种不同的形状（圆形和五角星形，不同的形状靠手感可以分辨）。现已知不同口味的糖和不同形状的数量统计如下表。参赛者需要在活动前决定摸出的糖果数目，那么，最少取出多少个糖果才能保证手中同时拥有不同形状的苹果味和桃子味的糖？（同时手中有圆形苹果味匹配五角星桃子味糖果，或者有圆形桃子味匹配五角星苹果味糖果都满足要求）
苹果味 桃子味 西瓜味
圆形 7 9 8
五角星形 7 6 4"""
CANDY_ANSWER = 21

# 写日志的锁：多个账号并发测试，同一文件追加时逐行写
_quality_log_lock = threading.Lock()


def read_credential(path):
    """从凭证文件取出测试需要的三样东西；缺任何一样返回 None。"""
    try:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh) or {}
    except Exception as e:
        log_error(f"读取凭证失败: {os.path.basename(path)}", e)
        return None
    cred = {
        "access_token": d.get("access_token") or "",
        "account_id": d.get("account_id") or "",
        "proxy_url": d.get("proxy_url") or "",
        "expired": d.get("expired") or "",
    }
    if not cred["access_token"] or not cred["account_id"]:
        return None
    return cred


def token_expiring(expired, margin_seconds=120):
    """access_token 是否已过期或即将过期。解析不了时按未过期处理，交给上游判断。"""
    if not expired:
        return False
    try:
        at = datetime.fromisoformat(expired.replace("Z", "+00:00"))
    except ValueError as e:
        log_error(f"无法解析令牌过期时间: {expired}", e)
        return False
    return at <= datetime.now(timezone.utc) + timedelta(seconds=margin_seconds)


def extract_answer(text):
    """
    从回答里取出最终数字。优先取最后一个 \\boxed{...}（模型习惯把结论框起来），
    其中若是算式如 28+1=29，取最后一个数；没有框就取结尾一段里的最后一个数。
    """
    boxed = re.findall(r"\\boxed\{([^{}]*)\}", text)
    source = boxed[-1] if boxed else text[-200:]
    nums = re.findall(r"\d+", source)
    return int(nums[-1]) if nums else None


def curl_config_quote(value):
    """curl -K 配置文件里的双引号字符串：反斜杠和双引号需要转义。"""
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_probe_stream(raw):
    """
    解析上游 SSE。返回 (回答文本, 完成事件里的 response 对象, 错误信息)。
    回答文本由 output_text.delta 拼出：store=false 时完成事件里不一定带完整 output。
    """
    text_parts, completed, error = [], None, ""
    for line in raw.splitlines():
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        try:
            ev = json.loads(payload)
        except json.JSONDecodeError:
            continue
        et = ev.get("type")
        if et == "response.output_text.delta":
            text_parts.append(ev.get("delta") or "")
        elif et == "response.completed":
            completed = ev.get("response") or {}
        elif et in ("response.failed", "error"):
            err = (ev.get("response") or {}).get("error") or ev.get("error") or ev
            error = (err.get("code") or err.get("type") or "") + ": " + (err.get("message") or "")
    return "".join(text_parts), completed, error.strip(": ")


def run_probe(f, model, effort):
    """
    对单个账号做一次测试，返回一条可直接写日志的记录。
    不抛异常：任何失败都记为 verdict=失败 并带上原因，便于事后区分「降智」和「没测成」。
    """
    record = {
        "ts": datetime.now().astimezone().isoformat(timespec="seconds"),
        "email": f.get("email") or "",
        "name": f.get("name") or "",
        "plan": plan_of(f) or "",
        "exit": exit_ip_of(f.get("proxy_url")),
        "model": model,
        "effort": effort,
        "verdict": "失败",
        "answer": None,
        "reasoning_tokens": None,
        "output_tokens": None,
        "elapsed": None,
        "error": "",
        "answer_tail": "",
    }

    cred = read_credential(f.get("path") or "")
    if not cred:
        record["error"] = "凭证缺少 access_token 或 account_id"
        return record
    if token_expiring(cred["expired"]):
        # 不在这里刷新：刷新只能由 CPA 做。等 CPA 刷新后下一轮再测
        record["error"] = "access_token 即将过期，等 CPA 自动刷新后再测"
        return record

    session_id = str(uuid.uuid4())
    body = {
        "model": model,
        "instructions": "You are a helpful assistant.",
        "input": [{"type": "message", "role": "user",
                   "content": [{"type": "input_text", "text": CANDY_PROMPT}]}],
        "tools": [],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "reasoning": {"effort": effort, "summary": "auto"},
        "store": False,
        "stream": True,
        "include": ["reasoning.encrypted_content"],
        # 每次用新的缓存键，避免命中上一次的缓存影响结果
        "prompt_cache_key": session_id,
    }

    # 敏感项（令牌、代理密码）写进 curl 配置走 stdin；请求体不含敏感信息，走临时文件
    config_lines = [
        f"url = {curl_config_quote(CODEX_RESPONSES_URL)}",
        f"header = {curl_config_quote('Authorization: Bearer ' + cred['access_token'])}",
        f"header = {curl_config_quote('Chatgpt-Account-Id: ' + cred['account_id'])}",
        f"header = {curl_config_quote('Session-Id: ' + session_id)}",
        f"header = {curl_config_quote('Originator: ' + PROBE_ORIGINATOR)}",
        f"user-agent = {curl_config_quote(PROBE_USER_AGENT)}",
        f"header = {curl_config_quote('Accept: text/event-stream')}",
        f"header = {curl_config_quote('Content-Type: application/json')}",
    ]
    if cred["proxy_url"]:
        config_lines.append(f"proxy = {curl_config_quote(cred['proxy_url'])}")

    body_path = None
    started = time.time()
    try:
        with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False, encoding="utf-8") as tmp:
            json.dump(body, tmp, ensure_ascii=False)
            body_path = tmp.name
        proc = subprocess.run(
            ["curl", "-sS", "-N", "--max-time", str(PROBE_TIMEOUT),
             "--data-binary", f"@{body_path}",
             "-w", "\n__HTTP_STATUS__:%{http_code}", "-K", "-"],
            input="\n".join(config_lines) + "\n",
            capture_output=True, text=True, timeout=PROBE_TIMEOUT + 30,
        )
    except subprocess.TimeoutExpired as e:
        log_error(f"测试超时: {record['email']}", e)
        record["error"] = f"超过 {PROBE_TIMEOUT} 秒未完成"
        return record
    except Exception as e:
        log_error(f"测试请求执行失败: {record['email']}", e)
        record["error"] = f"{type(e).__name__}: {e}"
        return record
    finally:
        record["elapsed"] = round(time.time() - started, 1)
        if body_path:
            try:
                os.unlink(body_path)
            except OSError as e:
                log_error("清理临时请求体失败", e)

    out = proc.stdout or ""
    status = ""
    if "__HTTP_STATUS__:" in out:
        out, status = out.rsplit("__HTTP_STATUS__:", 1)
        status = status.strip()
    if proc.returncode != 0 or status != "200":
        detail = (proc.stderr or "").strip() or out.strip()
        record["error"] = f"HTTP {status or '-'} curl={proc.returncode} {detail[:200]}"
        log_error(f"测试请求失败: {record['email']} {record['error']}")
        return record

    text, completed, stream_error = parse_probe_stream(out)
    if completed is None:
        record["error"] = stream_error or "上游未返回完成事件"
        return record

    usage = completed.get("usage") or {}
    record["reasoning_tokens"] = (usage.get("output_tokens_details") or {}).get("reasoning_tokens")
    record["output_tokens"] = usage.get("output_tokens")
    record["model"] = completed.get("model") or model
    record["answer"] = extract_answer(text)
    record["answer_tail"] = text.strip().replace("\n", " ")[-160:]
    record["verdict"] = "正常" if record["answer"] == CANDY_ANSWER else "降智"
    return record


def append_quality_log(record):
    """追加一条记录。日志只含结论与统计数字，不含令牌或代理密码。"""
    try:
        os.makedirs(os.path.dirname(QUALITY_LOG), mode=0o700, exist_ok=True)
        with _quality_log_lock, open(QUALITY_LOG, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record, ensure_ascii=False) + "\n")
    except Exception as e:
        log_error(f"写入质量日志失败: {QUALITY_LOG}", e)


def verdict_color(verdict):
    return {"正常": C_GREEN, "降智": C_RED}.get(verdict, C_YELLOW)


def print_probe_record(r):
    reasoning = r.get("reasoning_tokens")
    mark = ""
    if reasoning == DEGRADED_REASONING_MARK:
        mark = f" {C_DIM}(516 封顶特征){C_RESET}"
    detail = (
        f"答案 {r.get('answer')}  推理 {reasoning}{mark}  用时 {r.get('elapsed')}s"
        if r.get("verdict") != "失败" else f"{C_DIM}{r.get('error')}{C_RESET}"
    )
    print(
        f"  {verdict_color(r['verdict'])}{pad(r['verdict'], 5)}{C_RESET} "
        f"{pad(r['email'][:34], 35)} {pad(r.get('plan') or '?', 5)} {detail}"
    )


def cmd_probe(args):
    """
    probe [账号|all] [--effort E] [--model M] [--times N] [--quiet]
    给账号出一道固定逻辑题，判断是否降智，结果追加写入 QUALITY_LOG。
    多个账号并发测试；同一账号的多次测试串行，避免互相抢并发。
    """
    target, times, quiet = "all", 1, False
    model = CONFIG.get("QUALITY_MODEL") or DEFAULT_QUALITY_MODEL
    effort = CONFIG.get("QUALITY_EFFORT") or DEFAULT_QUALITY_EFFORT
    it = iter(args)
    for a in it:
        try:
            if a == "--effort":
                effort = next(it)
            elif a == "--model":
                model = next(it)
            elif a == "--times":
                times = max(1, int(next(it)))
            elif a == "--quiet":
                quiet = True
            elif a.startswith("-"):
                die(f"未知参数: {a}")
            else:
                target = a
        except (StopIteration, ValueError) as e:
            die(f"参数 {a} 缺少取值或取值不合法", e)

    if target == "all":
        files = [f for f in list_files()
                 if not f.get("disabled") and (f.get("provider") or f.get("type")) == "codex"]
    else:
        files = [resolve(target)]
    if not files:
        print("（没有可测试的启用中 Codex 账号）")
        return

    if not quiet:
        print(f"测试 {len(files)} 个账号 × {times} 次  模型 {model}  推理强度 {effort}")
        print(f"{C_DIM}正确答案 {CANDY_ANSWER}；高推理强度下正常回答可能要几分钟{C_RESET}")
        print()

    def probe_account(f):
        results = []
        for _ in range(times):
            r = run_probe(f, model, effort)
            append_quality_log(r)
            print_probe_record(r)
            results.append(r)
        return results

    with ThreadPoolExecutor(max_workers=len(files)) as pool:
        all_results = [r for rs in pool.map(probe_account, files) for r in rs]

    degraded = [r for r in all_results if r["verdict"] == "降智"]
    failed = [r for r in all_results if r["verdict"] == "失败"]
    print()
    print(f"共 {len(all_results)} 次：正常 {len(all_results) - len(degraded) - len(failed)}，"
          f"降智 {len(degraded)}，失败 {len(failed)}。记录已写入 {QUALITY_LOG}")


def load_quality_log(days):
    """读取最近 days 天的记录；坏行跳过并提示。"""
    if not os.path.exists(QUALITY_LOG):
        return []
    since = datetime.now().astimezone() - timedelta(days=days)
    rows = []
    with open(QUALITY_LOG, encoding="utf-8") as fh:
        for n, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                r = json.loads(line)
                if datetime.fromisoformat(r["ts"]) >= since:
                    rows.append(r)
            except (json.JSONDecodeError, KeyError, ValueError) as e:
                log_error(f"质量日志第 {n} 行格式异常，已跳过", e)
    return rows


def cmd_quality(args):
    """
    quality [--days N]      按账号汇总：正确率、推理 token 中位数、最近几次的走势
    quality log [条数]       按时间列出最近的原始记录，看「什么时候」开始降智
    """
    days = 7
    if args and args[0] == "log":
        limit = int(args[1]) if len(args) > 1 and args[1].isdigit() else 30
        rows = load_quality_log(3650)[-limit:]
        if not rows:
            print(f"（还没有记录，先跑 `cpa-account probe`）")
            return
        for r in rows:
            ts = r["ts"][5:16].replace("T", " ")
            print(f"{C_DIM}{ts}{C_RESET}", end="")
            print_probe_record(r)
        return
    if len(args) >= 2 and args[0] == "--days":
        try:
            days = max(1, int(args[1]))
        except ValueError as e:
            die("--days 需要整数", e)

    rows = load_quality_log(days)
    if not rows:
        print(f"（最近 {days} 天没有记录，先跑 `cpa-account probe`）")
        return

    by_email = {}
    for r in rows:
        by_email.setdefault(r["email"], []).append(r)

    cols = [("邮箱", 36), ("套餐", 6), ("有效", 6), ("正确率", 8),
            ("推理中位", 9), ("最近一次", 13), ("走势（旧→新）", 16)]
    header = " ".join(pad(t, w) for t, w in cols)
    print(f"最近 {days} 天  题目：糖果题（正确答案 {CANDY_ANSWER}）")
    print(f"{C_BOLD}{header}{C_RESET}")
    print("-" * width(header))
    for email, rs in sorted(by_email.items()):
        valid = [r for r in rs if r["verdict"] != "失败"]
        ok = [r for r in valid if r["verdict"] == "正常"]
        rate = f"{len(ok) * 100 // len(valid)}%" if valid else "-"
        reasoning = [r["reasoning_tokens"] for r in valid if isinstance(r.get("reasoning_tokens"), int)]
        med = str(int(statistics.median(reasoning))) if reasoning else "-"
        last = rs[-1]
        last_cell = f"{last['ts'][5:16].replace('T', ' ')}"
        # 走势：✓ 正常 ✗ 降智 · 失败，最多看最近 12 次
        trend = "".join({"正常": "✓", "降智": "✗"}.get(r["verdict"], "·") for r in rs[-12:])
        rate_color = C_GREEN if valid and len(ok) == len(valid) else (C_RED if valid and not ok else C_YELLOW)
        print(
            f"{pad(email[:34], cols[0][1])} "
            f"{pad(last.get('plan') or '?', cols[1][1])} "
            f"{pad(len(valid), cols[2][1])} "
            f"{rate_color}{pad(rate, cols[3][1])}{C_RESET} "
            f"{pad(med, cols[4][1])} "
            f"{pad(last_cell, cols[5][1])} "
            f"{trend}"
        )
    print()
    print(f"{C_DIM}✓ 答对  ✗ 答错（降智）  · 没测成（超时、网络、令牌）。"
          f"原始记录：cpa-account quality log{C_RESET}")


def owner_of(path):
    st = os.stat(path)
    return st.st_uid, st.st_gid


# ---------------------------------------------------------------- 入口

USAGE = f"""{C_BOLD}cpa-account{C_RESET} —— CLIProxyAPI 单实例账号管理

{C_BOLD}查看{C_RESET}
  list                          列出账号：状态、出口 IP、成败计数
  show <账号>                   单个账号的完整信息
  doctor [--fix]                体检；--fix 自动补上缺失的代理
  quota                         各账号配额窗口占用，并反推每周容量
  quality [--days N]            降智检测汇总：各账号正确率与走势
  quality log [条数]            降智检测的原始记录，按时间排列

{C_BOLD}添加{C_RESET}
  login                         Codex OAuth 登录，{C_GREEN}完成后自动配代理并启用{C_RESET}
  import <文件.json> [...]      导入已有凭证，{C_GREEN}同样自动配代理{C_RESET}

{C_BOLD}维护{C_RESET}
  proxy <账号|all> [IP] [端口]   下发 Decodo 代理，省略 IP/端口则用默认出口
  proxy-url <账号|all> <URL>    下发任意代理地址（Decodo 以外的供应商用这个）
  weight <账号> <权重>          手动设权重（需 routing.strategy=weighted-round-robin）
  rebalance                     按套餐重算所有账号的权重（pro 20 / plus 10）
  probe [账号|all] [--times N] [--effort E] [--model M]
                                给账号出糖果题测是否降智，结果记入日志
  refresh <账号>                手动刷新令牌
  enable <账号> / disable <账号>
  delete <账号>                 删除（需输入 yes 确认）

{C_BOLD}说明{C_RESET}
  <账号> 填邮箱片段即可，能唯一匹配就行，例如 berta、kaylyn。
  默认出口和 Decodo 账号从 {ENV_FILE} 读取，
  该文件缺代理参数时会自动从现有凭证反推，通常只需填 MGMT_KEY。

{C_BOLD}示例{C_RESET}
  cpa-account list
  cpa-account doctor --fix
  cpa-account proxy all
  cpa-account proxy berta <出口IP> 10001
"""

COMMANDS = {
    "list": cmd_list,
    "show": cmd_show,
    "doctor": cmd_doctor,
    "weight": cmd_weight,
    "rebalance": cmd_rebalance,
    "quota": cmd_quota,
    "probe": cmd_probe,
    "quality": cmd_quality,
    "proxy": cmd_proxy,
    "proxy-url": cmd_proxy_url,
    "refresh": cmd_refresh,
    "login": cmd_login,
    "import": cmd_import,
    "delete": cmd_delete,
    "enable": lambda a: cmd_state(a, False),
    "disable": lambda a: cmd_state(a, True),
}

if __name__ == "__main__":
    argv = sys.argv[1:]
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(USAGE)
        sys.exit(0)

    cmd, rest = argv[0], argv[1:]
    if cmd not in COMMANDS:
        log_error(f"未知命令: {cmd}")
        print(USAGE)
        sys.exit(1)

    CONFIG = load_env()
    try:
        COMMANDS[cmd](rest)
    except SystemExit:
        raise
    except KeyboardInterrupt:
        print("\n已中断")
        sys.exit(130)
    except Exception as e:
        die(f"命令 {cmd} 执行失败", e)

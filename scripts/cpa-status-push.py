#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
cpa-status-push —— 把 CLIProxyAPI 服务器的运行状态与异常推送到 ntfy

运行位置
--------
服务器本机，以 root 运行（要读 /opt/cliproxy 下的日志、凭证与面板文件，以及 Caddyfile）。
两个子命令，各由一个 systemd 定时器触发：

    cpa-status-push report [--dry-run]   每小时一条状态汇总（cpa-status-push.timer）
    cpa-status-push check  [--dry-run]   每 5 分钟检查一次异常，有变化才推（cpa-status-check.timer）

不带子命令等同于 report。--dry-run 只打印，不推送，也不写状态文件。

check 覆盖的事件
----------------
  1. 降智检测：每轮检测结束推一条汇总，并标出结论与上一轮不同的账号
  2. 配额：某账号某个窗口用到 80% / 95%
  3. 账号：被停用、不可用、冷却 / 出错且最近 30 分钟无成功、缺代理、令牌快过期没刷新
  4. CPA 重启或崩溃
  5. 线上面板不是本 fork 的构建（后端静默回退到上游面板）
  6. 管理接口 IP 被封（CPA 对管理接口返回 403），或连续用错密钥（401）
  7. 定时任务失败（cpa-quality / 本脚本自己的两个单元）
  8. TLS 证书 14 天内过期或校验失败
  另有：服务不在运行、磁盘 / 内存吃紧、最近 15 分钟客户端 5xx 激增。

持续性的问题（服务停了、配额超线、账号异常……）按「条件」处理：第一次出现推一次，
消失时推一条「已恢复」，期间不重复推。一次性的事情（重启、被封、一轮检测结束）按「事件」处理。
状态保存在 /var/lib/cliproxy/status-alerts.json。

配置文件
--------
/etc/cliproxy/cpa-status.env，权限 600，内容形如：

    NTFY_URL=https://ntfy.sh/<随机 topic>
    NTFY_TOKEN=<可选，自建或付费 ntfy 的访问令牌>

公共 ntfy.sh 的 topic 名就是唯一的访问凭据，任何知道名字的人都能订阅，
所以 topic 必须足够随机，推送内容里也不放完整邮箱、密钥等敏感信息（账号只显示邮箱前 4 位）。

账号相关的检查复用 /usr/local/bin/cpa-account 里的函数（管理接口调用、账号状态判定），
管理密钥也沿用它的 /etc/cliproxy/cpa-account.env。
"""

import argparse
import base64
import glob
import importlib.machinery
import importlib.util
import ipaddress
import json
import os
import re
import shutil
import socket
import ssl
import subprocess
import sys
import urllib.request
from collections import Counter
from datetime import datetime, timedelta, timezone

ENV_FILE = '/etc/cliproxy/cpa-status.env'
STATE_FILE = '/var/lib/cliproxy/status-alerts.json'
LOG_GLOB = '/opt/cliproxy/logs/main*.log'
CADDYFILE = '/etc/caddy/Caddyfile'
CPA_ACCOUNT = '/usr/local/bin/cpa-account'
QUALITY_LOG = '/var/lib/cliproxy/quality.jsonl'
PANEL_FILE = '/opt/cliproxy/static/management.html'
QUALITY_JOB_URL = 'http://127.0.0.1:8318/v0/management/quality-probe/job'
TLS_HOST = 'cliproxy.stallion-api.com'

# 需要保持运行的 systemd 单元
SERVICES = ['cliproxy', 'caddy', 'cpa-quality-api', 'cpa-quality.timer']
# 失败后需要告警的定时任务单元
JOB_UNITS = ['cpa-quality.service', 'cpa-status-push.service', 'cpa-status-check.service']

# 告警阈值
DISK_WARN_PCT = 85  # 根分区使用率
MEM_WARN_AVAIL_MB = 200  # 可用内存下限
LOAD_WARN = 2.0  # 1 分钟负载（机器是 2 核）
FAIL_RATE_WARN = 0.05  # 汇总里客户端可见的 5xx 比例
UPSTREAM_FAIL_WARN = 60  # 1 小时内上游失败（含已被重试挡住的）次数
SPIKE_WINDOW_MIN = 15  # 5xx 激增的统计窗口
SPIKE_MIN_COUNT = 5  # 窗口内 5xx 至少这么多次
SPIKE_MIN_RATE = 0.2  # 且占比至少这么高
QUOTA_LEVELS = (80, 95)  # 配额告警档位（%）
TOKEN_EXPIRY_WARN = timedelta(hours=12)  # CPA 提前 24 小时刷新，剩 12 小时还没刷就是刷新出了问题
CERT_WARN_DAYS = 14
BAD_KEY_WARN = 3  # 一次检查间隔内管理接口 401 达到这么多次
# 条件要连续出现几次检查才告警（前缀匹配，未列出的出现一次就告警）。
# 账号被上游过载短暂冷却很常见，几分钟内就会自己恢复，持续 15 分钟才值得打扰。
DEBOUNCE = {'account:': 3, '5xx-spike': 2}
# 线上面板里必须出现的字符串：降智检测接口路径只有本 fork 的面板会调用
PANEL_FORK_MARKER = b'/quality-probe'

# 日志行：[2026-09-27 20:20:20] [88a3f7b3] [info ] [gin_logger.go:103] 200 | 3.638s | ip | POST "/v1/..."
TS_RE = re.compile(r'^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]')
GIN_RE = re.compile(r'\[gin_logger\.go:\d+\]\s+(\d{3})\s+\|[^|]*\|\s*(\S+)\s*\|\s*\S+\s+"([^"]*)"')
UPSTREAM_CODE_RE = re.compile(r'"code":"([a-z_]+)"')
TS_FMT = '%Y-%m-%d %H:%M:%S'


def log(msg):
    """输出到 stderr，由 journald 收集。"""
    print(msg, file=sys.stderr)


# ---------------------------------------------------------------- 配置与状态


def load_env(path):
    """读取 KEY=VALUE 形式的配置文件，忽略空行和注释。"""
    env = {}
    try:
        with open(path, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                key, value = line.split('=', 1)
                env[key.strip()] = value.strip().strip('"').strip("'")
    except OSError as e:
        log(f'[error] 读取配置 {path} 失败: {e}')
    return env


def load_state():
    """读取上次检查留下的状态；文件不存在视为首次运行。"""
    try:
        with open(STATE_FILE, encoding='utf-8') as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as e:
        log(f'[error] 读取状态文件 {STATE_FILE} 失败，按首次运行处理: {e}')
        return {}


def save_state(state):
    """先写临时文件再改名，避免写到一半被读到。"""
    tmp = STATE_FILE + '.tmp'
    try:
        os.makedirs(os.path.dirname(STATE_FILE), mode=0o700, exist_ok=True)
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
        os.replace(tmp, STATE_FILE)
    except OSError as e:
        log(f'[error] 写入状态文件 {STATE_FILE} 失败: {e}')


def load_cpa_account():
    """
    以模块方式加载 cpa-account（文件没有 .py 后缀，要显式指定加载器），
    并补上它在 __main__ 里才初始化的 CONFIG。失败返回 None，账号类检查随之跳过。
    """
    try:
        loader = importlib.machinery.SourceFileLoader('cpa_account', CPA_ACCOUNT)
        spec = importlib.util.spec_from_loader('cpa_account', loader)
        module = importlib.util.module_from_spec(spec)
        loader.exec_module(module)
        module.CONFIG = module.load_env()
        return module
    except (Exception, SystemExit) as e:  # noqa: BLE001 —— load_env 缺密钥时会 sys.exit
        log(f'[error] 加载 {CPA_ACCOUNT} 失败，跳过账号类检查: {type(e).__name__}: {e}')
        return None


def short_name(email, plan=''):
    """账号在推送里的显示名：邮箱前 4 位 + 套餐，避免在公共 topic 上暴露完整邮箱。"""
    head = (email or '?')[:4]
    return f'{head}…({plan})' if plan else f'{head}…'


# ---------------------------------------------------------------- 系统与服务


def read_system():
    """负载、可用内存（MB）、根分区使用率（%）与运行时长。"""
    load1 = os.getloadavg()[0]
    mem = {}
    try:
        with open('/proc/meminfo', encoding='utf-8') as f:
            for line in f:
                key, value = line.split(':', 1)
                mem[key] = int(value.split()[0])  # 单位 kB
    except (OSError, ValueError) as e:
        log(f'[error] 读取 /proc/meminfo 失败: {e}')
    disk = shutil.disk_usage('/')
    uptime_days = 0
    try:
        with open('/proc/uptime', encoding='utf-8') as f:
            uptime_days = int(float(f.read().split()[0]) // 86400)
    except (OSError, ValueError) as e:
        log(f'[error] 读取 /proc/uptime 失败: {e}')
    return {
        'load1': load1,
        'mem_total_mb': mem.get('MemTotal', 0) // 1024,
        'mem_avail_mb': mem.get('MemAvailable', 0) // 1024,
        'disk_pct': disk.used * 100 // disk.total if disk.total else 0,
        'disk_free_gb': disk.free / 1024**3,
        'uptime_days': uptime_days,
    }


def systemctl(*args):
    """执行 systemctl 并返回标准输出；出错时返回空串。"""
    try:
        out = subprocess.run(
            ['systemctl', *args], capture_output=True, text=True, timeout=10
        )
        return out.stdout.strip()
    except (OSError, subprocess.SubprocessError) as e:
        log(f'[error] systemctl {" ".join(args)} 失败: {e}')
        return ''


def read_services():
    """返回 {单元名: is-active 结果}。"""
    return {unit: systemctl('is-active', unit) or 'unknown' for unit in SERVICES}


def read_allowlist():
    """从 Caddyfile 的 `not remote_ip ...` 行解析管理面白名单，与 Caddy 实际配置保持一致。"""
    nets = [ipaddress.ip_network('127.0.0.0/8'), ipaddress.ip_network('::1/128')]
    try:
        with open(CADDYFILE, encoding='utf-8') as f:
            for line in f:
                parts = line.split()
                if parts[:2] == ['not', 'remote_ip']:
                    for item in parts[2:]:
                        try:
                            nets.append(ipaddress.ip_network(item, strict=False))
                        except ValueError as e:
                            log(f'[error] 白名单条目 {item} 解析失败: {e}')
    except OSError as e:
        log(f'[error] 读取 {CADDYFILE} 失败: {e}')
    return nets


def in_allowlist(ip, nets):
    """判断 IP 是否落在白名单网段里；无法解析的一律算不在。"""
    try:
        addr = ipaddress.ip_address(ip)
    except ValueError:
        return False
    return any(addr in net for net in nets)


# ---------------------------------------------------------------- 日志统计


def recent_log_lines(since_str):
    """按时间顺序返回时间戳晚于 since_str 的日志行；日志轮转时会顺带读上一个文件。"""
    files = sorted(glob.glob(LOG_GLOB), key=os.path.getmtime)[-2:]
    lines = []
    for path in files:
        try:
            with open(path, encoding='utf-8', errors='replace') as f:
                for line in f:
                    m = TS_RE.match(line)
                    if m and m.group(1) > since_str:
                        lines.append((m.group(1), line))
        except OSError as e:
            log(f'[error] 读取日志 {path} 失败: {e}')
    return lines


def parse_traffic(lines, allowlist):
    """统计请求状态码、上游失败错误码，以及管理接口的非白名单来源、401、403。"""
    stats = {
        'status': Counter(),
        'upstream': Counter(),
        'foreign_admin': Counter(),
        'admin_401': Counter(),
        'admin_403': Counter(),
    }
    for _, line in lines:
        m = GIN_RE.search(line)
        if m:
            code, ip, path = m.groups()
            stats['status'][code] += 1
            if path.startswith('/v0/management'):
                if not in_allowlist(ip, allowlist):
                    stats['foreign_admin'][ip] += 1
                if code == '401':
                    stats['admin_401'][ip] += 1
                elif code == '403':
                    stats['admin_403'][ip] += 1
            continue
        if 'upstream execution failed' in line:
            cm = UPSTREAM_CODE_RE.search(line)
            stats['upstream'][cm.group(1) if cm else 'other'] += 1
    return stats


# ---------------------------------------------------------------- 推送


def push(env, title, body, priority='default', tags=''):
    """发送到 ntfy。标题走 HTTP 头，按 RFC 2047 编码以支持中文和 emoji。"""
    url = env.get('NTFY_URL')
    if not url:
        log('[error] 未配置 NTFY_URL')
        return False
    headers = {
        'Title': '=?UTF-8?B?' + base64.b64encode(title.encode()).decode() + '?=',
        'Priority': priority,
    }
    if tags:
        headers['Tags'] = tags
    if env.get('NTFY_TOKEN'):
        headers['Authorization'] = f'Bearer {env["NTFY_TOKEN"]}'
    req = urllib.request.Request(url, data=body.encode('utf-8'), headers=headers, method='POST')
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return 200 <= resp.status < 300
    except Exception as e:  # noqa: BLE001 —— 网络层异常种类多，统一记录后返回失败
        log(f'[error] 推送 ntfy 失败: {e}')
        return False


def emit(args, env, title, body, priority='default', tags=''):
    """dry-run 时打印，否则推送。返回是否成功。"""
    if args.dry_run:
        print(f'--- [{priority}] {title}\n{body}\n')
        return True
    return push(env, title, body, priority, tags)


# ---------------------------------------------------------------- report：每小时汇总


def cmd_report(args, env):
    """统计过去 1 小时并推送一条汇总。"""
    since = (datetime.now() - timedelta(hours=1)).strftime(TS_FMT)
    system = read_system()
    services = read_services()
    stats = parse_traffic(recent_log_lines(since), read_allowlist())
    status, upstream, foreign_admin = stats['status'], stats['upstream'], stats['foreign_admin']

    warnings = []
    down = [name for name, state in services.items() if state != 'active']
    if down:
        warnings.append('服务异常: ' + ', '.join(f'{n}={services[n]}' for n in down))
    if system['disk_pct'] >= DISK_WARN_PCT:
        warnings.append(f'磁盘已用 {system["disk_pct"]}%')
    if system['mem_avail_mb'] < MEM_WARN_AVAIL_MB:
        warnings.append(f'可用内存仅 {system["mem_avail_mb"]}MB')
    if system['load1'] >= LOAD_WARN:
        warnings.append(f'负载 {system["load1"]:.2f}')
    total = sum(status.values())
    errors_5xx = sum(n for code, n in status.items() if code.startswith('5'))
    if total and errors_5xx / total >= FAIL_RATE_WARN:
        warnings.append(f'5xx 占比 {errors_5xx * 100 / total:.1f}%')
    upstream_total = sum(upstream.values())
    if upstream_total >= UPSTREAM_FAIL_WARN:
        warnings.append(f'上游失败 {upstream_total} 次')
    if foreign_admin:
        warnings.append('管理接口出现白名单外 IP')

    lines = []
    if warnings:
        lines.append('注意: ' + '；'.join(warnings))
        lines.append('')
    lines.append(
        f'负载 {system["load1"]:.2f} · 内存可用 {system["mem_avail_mb"]}/'
        f'{system["mem_total_mb"]}MB · 磁盘 {system["disk_pct"]}%'
        f'（剩 {system["disk_free_gb"]:.0f}G）· 已运行 {system["uptime_days"]} 天'
    )
    lines.append('服务: ' + ' '.join(
        f'{name}{"✓" if state == "active" else "✗"}' for name, state in services.items()
    ))
    codes = ' '.join(f'{code}×{n}' for code, n in sorted(status.items())) or '无'
    lines.append(f'近 1 小时请求 {total}: {codes}')
    if upstream:
        detail = ' '.join(f'{code}×{n}' for code, n in upstream.most_common())
        lines.append(f'上游失败 {upstream_total}（含已重试成功的）: {detail}')
    else:
        lines.append('上游失败 0')
    if foreign_admin:
        lines.append('白名单外管理访问: ' + ' '.join(
            f'{ip}×{n}' for ip, n in foreign_admin.most_common(5)
        ))

    # 真正需要处理的异常由 check 以 high 优先级即时推送，汇总本身保持安静
    title = f'{"⚠️ " if warnings else "✅ "}CPA {socket.gethostname()} 状态'
    ok = emit(args, env, title, '\n'.join(lines),
              'default' if warnings else 'low',
              'warning' if warnings else 'white_check_mark')
    return 0 if ok else 1


# ---------------------------------------------------------------- check：各项检查
# 每个 check_* 往 conditions 里放 {键: 描述}（持续性问题），往 events 里追加描述（一次性事件）。


def check_system(conditions):
    """服务停止、磁盘、内存。负载短时波动大，只在汇总里提示。"""
    for name, state in read_services().items():
        if state != 'active':
            conditions[f'service:{name}'] = f'服务 {name} 状态为 {state}'
    system = read_system()
    if system['disk_pct'] >= DISK_WARN_PCT:
        conditions['disk'] = f'磁盘已用 {system["disk_pct"]}%'
    if system['mem_avail_mb'] < MEM_WARN_AVAIL_MB:
        conditions['memory'] = f'可用内存仅 {system["mem_avail_mb"]}MB'


def check_logs(state, conditions, events, allowlist):
    """5xx 激增（条件）；管理接口被封、连续用错密钥（事件）。"""
    now = datetime.now()
    spike_since = (now - timedelta(minutes=SPIKE_WINDOW_MIN)).strftime(TS_FMT)
    # 事件只看上次检查之后的新日志；首次运行只回看 5 分钟，避免把旧事翻出来
    last_ts = state.get('log_ts') or (now - timedelta(minutes=5)).strftime(TS_FMT)
    lines = recent_log_lines(min(spike_since, last_ts))

    spike = parse_traffic([x for x in lines if x[0] > spike_since], allowlist)['status']
    total = sum(spike.values())
    errors = sum(n for code, n in spike.items() if code.startswith('5'))
    if errors >= SPIKE_MIN_COUNT and errors / total >= SPIKE_MIN_RATE:
        conditions['5xx-spike'] = (
            f'最近 {SPIKE_WINDOW_MIN} 分钟客户端 5xx {errors}/{total}'
            f'（{errors * 100 / total:.0f}%）'
        )

    fresh = parse_traffic([x for x in lines if x[0] > last_ts], allowlist)
    for ip, n in fresh['admin_403'].items():
        # Caddy 的白名单 403 不会进 CPA 日志，这里的 403 只可能是 CPA 的封禁或远程管理关闭
        events.append(f'管理接口拒绝 {ip} {n} 次（403，多半是连续密钥错误后被封 30 分钟，'
                      f'见 DEPLOYMENT.md 5.6；清除封禁需重启 cliproxy）')
    for ip, n in fresh['admin_401'].items():
        if n >= BAD_KEY_WARN:
            events.append(f'{ip} 用错误的管理密钥访问 {n} 次（401），累计 5 次会被封')
    if lines:
        state['log_ts'] = max(state.get('log_ts') or '', lines[-1][0])
    else:
        state.setdefault('log_ts', last_ts)


def check_restart(state, events):
    """cliproxy 的 InvocationID 变了就是重启过；日志里有异常退出记录就算崩溃。"""
    invocation = systemctl('show', 'cliproxy', '-p', 'InvocationID', '--value')
    previous = state.get('cliproxy_invocation')
    if invocation and previous and invocation != previous:
        since = state.get('checked_at') or '-10min'
        try:
            journal = subprocess.run(
                ['journalctl', '-u', 'cliproxy', '--since', since, '--no-pager', '-o', 'cat'],
                capture_output=True, text=True, timeout=20,
            ).stdout
        except (OSError, subprocess.SubprocessError) as e:
            log(f'[error] 读取 cliproxy 日志失败: {e}')
            journal = ''
        crash = [
            line for line in journal.splitlines()
            if ('Main process exited' in line and 'status=0/SUCCESS' not in line)
            or 'Failed with result' in line
        ]
        if crash:
            events.append('cliproxy 异常退出后被拉起: ' + crash[-1].strip()[:160])
        else:
            events.append('cliproxy 重启过（正常停止后启动，多半是手动 restart）')
    if invocation:
        state['cliproxy_invocation'] = invocation


def check_jobs(conditions):
    """定时任务单元进入 failed 状态。"""
    for unit in JOB_UNITS:
        if systemctl('is-failed', unit) == 'failed':
            conditions[f'job:{unit}'] = f'定时任务 {unit} 上次运行失败（journalctl -u {unit}）'


def check_panel(conditions):
    """面板文件里找不到 fork 特征，说明后端回退到了上游面板（DEPLOYMENT.md 5.2）。"""
    try:
        with open(PANEL_FILE, 'rb') as f:
            content = f.read()
    except OSError as e:
        conditions['panel'] = f'读取面板文件失败: {e}'
        return
    if PANEL_FORK_MARKER not in content:
        conditions['panel'] = '线上面板不是本 fork 的构建，后端可能已回退到上游面板（见 DEPLOYMENT.md 5.2）'


def check_cert(conditions):
    """连本机 443 取证书，按正常客户端的方式校验，顺带看剩余天数。"""
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection(('127.0.0.1', 443), timeout=10) as sock:
            with ctx.wrap_socket(sock, server_hostname=TLS_HOST) as tls:
                cert = tls.getpeercert()
        expires = datetime.fromtimestamp(ssl.cert_time_to_seconds(cert['notAfter']), timezone.utc)
    except (OSError, ssl.SSLError, KeyError, ValueError) as e:
        conditions['cert'] = f'TLS 证书检查失败: {type(e).__name__}: {e}'
        return
    days = (expires - datetime.now(timezone.utc)).days
    if days < CERT_WARN_DAYS:
        conditions['cert'] = f'TLS 证书 {days} 天后过期（Caddy 应已自动续期，检查 journalctl -u caddy）'


def read_token_expiry(path):
    """从凭证文件读 access_token 过期时间；读不到返回 None。"""
    try:
        with open(path, encoding='utf-8') as f:
            raw = (json.load(f) or {}).get('expired') or ''
        return datetime.fromisoformat(raw.replace('Z', '+00:00')) if raw else None
    except (OSError, ValueError) as e:
        log(f'[error] 读取令牌过期时间失败: {os.path.basename(path)}: {e}')
        return None


def quota_windows(f):
    """返回 [(窗口名, 已用百分比)]；窗口长度 ≥ 1 周的叫「周」，否则按小时数命名。"""
    sig = (f.get('quota') or {}).get('signals') or {}
    result = []
    for prefix in ('Primary', 'Secondary'):
        try:
            minutes = float(sig.get(f'X-Codex-{prefix}-Window-Minutes') or 0)
            used = float(sig.get(f'X-Codex-{prefix}-Used-Percent') or 0)
        except (TypeError, ValueError) as e:
            log(f'[error] 配额信号格式异常: {f.get("name")}: {e}')
            continue
        if minutes > 0:
            label = '周' if minutes >= 10080 else f'{minutes / 60:.0f}小时'
            result.append((label, used))
    return result


def check_accounts(cpa, state, conditions, events):
    """账号状态、代理、令牌、配额。数据来自 cpa-account 的 list_files()（管理接口 + 磁盘）。"""
    try:
        files = cpa.api('GET', '/auth-files').get('files', [])
    except Exception as e:  # noqa: BLE001 —— api() 已记录细节
        conditions['accounts-api'] = f'读取账号列表失败: {type(e).__name__}'
        return
    now = datetime.now(timezone.utc)
    disabled_before = set(state.get('disabled_accounts') or [])
    disabled_now = set()
    for f in files:
        f['proxy_url'] = cpa.read_proxy_from_disk(f.get('path') or '')
        name = f.get('name') or '?'
        label = short_name(f.get('email'), cpa.plan_of(f))
        if f.get('disabled'):
            disabled_now.add(name)
            if name not in disabled_before and state.get('disabled_accounts') is not None:
                events.append(f'账号 {label} 被停用')
            continue
        account_state, _ = cpa.state_of(f)
        if account_state != '正常':
            # status_message 常是上游原样的 JSON，只取错误码更易读
            raw = f.get('status_message') or ''
            cm = UPSTREAM_CODE_RE.search(raw)
            message = cm.group(1) if cm else raw[:100]
            conditions[f'account:{name}'] = f'账号 {label} {account_state}' + (
                f': {message}' if message else '')
        if not f['proxy_url']:
            conditions[f'proxy:{name}'] = f'账号 {label} 缺代理，正在用机房 IP 直连（cpa-account doctor --fix）'
        if f.get('provider') == 'codex':
            expires = read_token_expiry(f.get('path') or '')
            if expires and expires - now < TOKEN_EXPIRY_WARN:
                conditions[f'token:{name}'] = (
                    f'账号 {label} 令牌 {expires.astimezone():%m-%d %H:%M} 过期，CPA 没有按时刷新'
                    f'（cpa-account refresh 或重新登录）')
        for window, used in quota_windows(f):
            level = max((lv for lv in QUOTA_LEVELS if used >= lv), default=0)
            if level:
                # 档位写进键里，80% 升到 95% 会作为新条件再推一次
                conditions[f'quota:{name}:{window}:{level}'] = f'账号 {label} {window}配额已用 {used:.0f}%'
    for name in disabled_before - disabled_now:
        events.append(f'账号 {name.split("-")[1] if "-" in name else name} 已重新启用或已删除')
    state['disabled_accounts'] = sorted(disabled_now)


def probe_running(cpa):
    """定时检测或网页触发的检测是否还在进行；这时新记录还不完整，先不汇总。"""
    if systemctl('is-active', 'cpa-quality.service') in ('active', 'activating'):
        return True
    if cpa is None:
        return False
    req = urllib.request.Request(
        QUALITY_JOB_URL, headers={'Authorization': f'Bearer {cpa.CONFIG["MGMT_KEY"]}'}
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode('utf-8') or '{}')
    except Exception as e:  # noqa: BLE001 —— 查不到就当作没在跑
        log(f'[error] 查询网页检测任务失败: {e}')
        return False
    job = data.get('job', data) if isinstance(data, dict) else {}
    return isinstance(job, dict) and job.get('status') == 'running'


def check_quality(cpa, state, args, env):
    """检测一轮结束后推一条汇总，并对比每个账号与上一次有效结论。"""
    last_ts = state.get('quality_ts')
    records = []
    try:
        with open(QUALITY_LOG, encoding='utf-8') as f:
            for line in f:
                try:
                    records.append(json.loads(line))
                except ValueError as e:
                    log(f'[error] 质量日志有一行无法解析，已跳过: {e}')
    except FileNotFoundError:
        return
    except OSError as e:
        log(f'[error] 读取质量日志失败: {e}')
        return
    if not records:
        return
    if last_ts is None:
        # 首次运行只记位置，不把历史记录当成新一轮推出去
        state['quality_ts'] = max(r.get('ts', '') for r in records)
        state['quality_last'] = latest_verdicts(records)
        return
    fresh = [r for r in records if r.get('ts', '') > last_ts]
    if not fresh or probe_running(cpa):
        return

    previous = state.get('quality_last') or {}
    counts = Counter(r.get('verdict') for r in fresh)
    lines, changes = [], []
    for r in fresh:
        email, verdict = r.get('email') or r.get('name'), r.get('verdict')
        label = short_name(email, r.get('plan', ''))
        detail = (f'答 {r.get("answer")}，推理 {r.get("reasoning_tokens")}'
                  if verdict != '失败' else (r.get('error') or '')[:60])
        lines.append(f'{"✓" if verdict == "正常" else "✗" if verdict == "降智" else "·"} '
                     f'{label} {verdict}（{detail}）')
        before = previous.get(email)
        if verdict != '失败' and before and before != verdict:
            changes.append(f'{label} {before}→{verdict}')
    started = min(r.get('ts', '') for r in fresh)[5:16].replace('T', ' ')
    body = [f'正常 {counts.get("正常", 0)} · 降智 {counts.get("降智", 0)} · 失败 {counts.get("失败", 0)}']
    if changes:
        body.append('变化: ' + '；'.join(changes))
    body.extend(lines)
    degraded_now = any('→降智' in c for c in changes)
    title = f'{"⚠️ " if degraded_now else ""}降智检测 {started}'
    if emit(args, env, title, '\n'.join(body),
            'high' if degraded_now else 'default', 'mag'):
        state['quality_ts'] = max(r.get('ts', '') for r in fresh)
        state['quality_last'] = {**previous, **latest_verdicts(fresh)}


def latest_verdicts(records):
    """每个账号最近一次有效（非失败）结论。"""
    result = {}
    for r in sorted(records, key=lambda x: x.get('ts', '')):
        if r.get('verdict') in ('正常', '降智'):
            result[r.get('email') or r.get('name')] = r['verdict']
    return result


def cmd_check(args, env):
    """跑全部检查，把新出现 / 已恢复的条件和新事件合成一条推送。"""
    state = load_state()
    conditions, events = {}, []
    cpa = load_cpa_account()

    check_system(conditions)
    check_logs(state, conditions, events, read_allowlist())
    check_restart(state, events)
    check_jobs(conditions)
    check_panel(conditions)
    check_cert(conditions)
    if cpa is not None:
        check_accounts(cpa, state, conditions, events)
    check_quality(cpa, state, args, env)

    active = state.get('active') or {}
    # 防抖：记下每个条件连续出现的次数，没达到次数且之前没告警过的先不算
    seen = {k: (state.get('seen') or {}).get(k, 0) + 1 for k in conditions}
    state['seen'] = seen

    def need(key):
        return next((n for prefix, n in DEBOUNCE.items() if key.startswith(prefix)), 1)

    conditions = {k: v for k, v in conditions.items() if k in active or seen[k] >= need(k)}
    new = {k: v for k, v in conditions.items() if k not in active}
    resolved = {k: v for k, v in active.items() if k not in conditions}

    ok = True
    if new or resolved or events:
        lines = [f'⚠️ {v}' for v in new.values()]
        lines += [f'❗ {e}' for e in events]
        lines += [f'✅ 已恢复: {v}' for v in resolved.values()]
        if new or events:
            title = f'⚠️ CPA 告警（{len(new) + len(events)} 项）'
            priority, tags = 'high', 'rotating_light'
        else:
            title = f'✅ CPA 已恢复（{len(resolved)} 项）'
            priority, tags = 'default', 'white_check_mark'
        still = len(conditions) - len(new)
        if still:
            lines.append(f'（另有 {still} 项仍未恢复）')
        ok = emit(args, env, title, '\n'.join(lines), priority, tags)

    # 推送失败时不更新 active，下次检查会重试同一批通知
    if ok:
        state['active'] = conditions
    state['checked_at'] = datetime.now().strftime(TS_FMT)
    if not args.dry_run:
        save_state(state)
    return 0 if ok else 1


def main():
    parser = argparse.ArgumentParser(description='推送 CLIProxyAPI 服务器状态与异常到 ntfy')
    parser.add_argument('command', nargs='?', default='report', choices=['report', 'check'],
                        help='report：每小时汇总（默认）；check：异常检查')
    parser.add_argument('--dry-run', action='store_true', help='只打印，不推送，不写状态')
    args = parser.parse_args()
    env = load_env(ENV_FILE)
    return cmd_check(args, env) if args.command == 'check' else cmd_report(args, env)


if __name__ == '__main__':
    sys.exit(main())

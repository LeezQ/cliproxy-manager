#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
flclash-decodo —— 把 Decodo 住宅出口重新套回 FlClash 订阅配置

为什么需要这个脚本
------------------
FlClash 会定时重新拉取订阅并整个覆盖 profiles/<id>.yaml，手改的内容会丢。
它自带的「覆写」只支持代理组和规则，塞不进自定义节点，而 Decodo 是个 socks5 节点。
所以只能改订阅文件本身，改完再用这个脚本随时恢复。

配套动作：已把该订阅的自动更新关掉（auto_update=0），
手动更新订阅之后重跑一次本脚本即可。

用法
----
  flclash-decodo.py            # 应用配置并重启 FlClash
  flclash-decodo.py --check    # 只检查当前状态（含境外 UDP 是否泄漏的实测），不改动
  flclash-decodo.py --revert   # 还原成订阅原样（从备份恢复）
"""

import io
import json
import os
import socket
import struct
import sys
import glob
import time
import shutil
import sqlite3
import subprocess

APP_DIR = os.path.expanduser("~/Library/Application Support/com.follow.clash")
PROFILE_DIR = os.path.join(APP_DIR, "profiles")
DB_PATH = os.path.join(APP_DIR, "database.sqlite")
PROFILE_ID = "305906101000343552"          # AgentNEO 订阅
PROFILE = os.path.join(PROFILE_DIR, f"{PROFILE_ID}.yaml")

NODE_NAME = "Decodo-住宅JP"

# 境外 UDP 一律拦截，放在规则最前面。
# 为什么：Decodo 节点不支持 UDP（udp: false）。Clash 匹配 UDP 时会跳过不支持 UDP 的节点，
# 一条都匹配不上就走 DIRECT——于是浏览器的 HTTP/3（QUIC）和 WebRTC 全部用本地宽带 IP 直出。
# 2026-09-29 实测：TCP 出口是日本住宅 IP，UDP 出口却是浙江移动 IP，面板因此被 IP 白名单拦下，
# ChatGPT 网页（Cloudflare 支持 HTTP/3）也有一部分请求从国内 IP 发出。
# 拦掉之后浏览器会自动退回 TCP，走住宅出口；国内 UDP（音视频通话等）不受影响。
UDP_GUARD_RULE = "- AND,((NETWORK,UDP),(NOT,((GEOIP,CN)))),REJECT"
STUN_SERVERS = [("stun.l.google.com", 19302), ("stun.cloudflare.com", 3478)]
GROUP_NAME = "住宅IP"
RELAY_GROUP = "中转"

# Decodo 凭据外置到 ~/.config/cpa/decodo.env（600），不写进脚本——
# 本脚本的副本会进公开仓库，硬编码密码等于公开泄漏。
CRED_FILE = os.path.expanduser("~/.config/cpa/decodo.env")


def load_decodo():
    """
    读取 Decodo 凭据。文件格式为 KEY=VALUE，至少需要：
      DECODO_USER / DECODO_PASS / EXIT_IP / EXIT_PORT
    用户名里的 -ip-<地址> 才是锁定出口的部分，端口只是入口。
    """
    env = {}
    try:
        with io.open(CRED_FILE, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
    except FileNotFoundError:
        log_error(f"缺少凭据文件 {CRED_FILE}，内容示例：\n"
                  "  DECODO_USER=xxx\n  DECODO_PASS=xxx\n"
                  "  EXIT_IP=1.2.3.4\n  EXIT_PORT=10001")
        sys.exit(1)
    except Exception as e:
        log_error(f"读取 {CRED_FILE} 失败", e)
        sys.exit(1)

    missing = [k for k in ("DECODO_USER", "DECODO_PASS", "EXIT_IP", "EXIT_PORT")
               if not env.get(k)]
    if missing:
        log_error(f"{CRED_FILE} 缺少字段: {', '.join(missing)}")
        sys.exit(1)
    return {
        "server": "isp.decodo.com",
        "port": env["EXIT_PORT"],
        "username": f"user-{env['DECODO_USER']}-ip-{env['EXIT_IP']}",
        "password": env["DECODO_PASS"],
    }


def log(msg):
    print(f"  {msg}")


def log_error(msg, exc=None):
    detail = f" | {type(exc).__name__}: {exc}" if exc is not None else ""
    print(f"[错误] {msg}{detail}", file=sys.stderr)


def quit_flclash():
    """退出 FlClash。用 osascript 让它正常保存状态，而不是直接 kill。"""
    try:
        subprocess.run(
            ["osascript", "-e", 'tell application "FlClash" to quit'],
            capture_output=True, timeout=20,
        )
    except Exception as e:
        log_error("退出 FlClash 失败，继续尝试", e)
    for _ in range(10):
        if not subprocess.run(["pgrep", "-f", "FlClashCore"],
                              capture_output=True).stdout.strip():
            return True
        time.sleep(1)
    return False


def start_flclash():
    try:
        subprocess.run(["open", "-a", "FlClash"], capture_output=True, timeout=20)
    except Exception as e:
        log_error("启动 FlClash 失败", e)
        return False
    time.sleep(10)
    return True


def disable_auto_update():
    """
    关掉该订阅的自动更新。
    默认是每 10 分钟拉一次，会把本脚本写入的内容整个冲掉。
    """
    try:
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
        cur.execute("SELECT auto_update FROM profiles WHERE id = ?", (PROFILE_ID,))
        row = cur.fetchone()
        if row is None:
            log_error(f"数据库里找不到订阅 {PROFILE_ID}")
            con.close()
            return False
        if row[0] == 0:
            log("订阅自动更新：已是关闭状态")
        else:
            cur.execute("UPDATE profiles SET auto_update = 0 WHERE id = ?", (PROFILE_ID,))
            con.commit()
            log("订阅自动更新：已关闭（原为每 10 分钟）")
        con.close()
        return True
    except Exception as e:
        log_error("修改数据库失败", e)
        return False


def apply_profile():
    """把节点、代理组、规则改写进订阅文件。幂等，重复执行不会叠加。"""
    if not os.path.exists(PROFILE):
        log_error(f"订阅文件不存在: {PROFILE}")
        return False

    text = io.open(PROFILE, encoding="utf-8").read()
    if NODE_NAME in text:
        log("配置已是套用状态，无需改动")
        return True

    # 备份一份订阅原样，--revert 用得上
    origin = PROFILE + ".origin"
    if not os.path.exists(origin):
        shutil.copyfile(PROFILE, origin)
        log(f"已保存订阅原样副本: {os.path.basename(origin)}")

    lines = text.split("\n")
    decodo = load_decodo()

    # 1) 插入 Decodo 节点。该订阅的列表项一律顶格，保持一致。
    try:
        pi = lines.index("proxies:")
    except ValueError as e:
        log_error("找不到 proxies 段", e)
        return False
    node = [
        f"- name: {NODE_NAME}",
        "  type: socks5",
        f"  server: {decodo['server']}",
        f"  port: {decodo['port']}",
        f"  username: {decodo['username']}",
        f"  password: {decodo['password']}",
        "  udp: false",
        # 前置跳板不能指向 PROXY：下面会把 PROXY 的流量整体改走 Decodo，
        # 再指回去就成了自己套自己的死循环。
        f"  dialer-proxy: {RELAY_GROUP}",
    ]
    lines[pi + 1:pi + 1] = node

    # 2) 复制 PROXY 的成员，建一个「中转」组专门给 dialer-proxy 用
    try:
        gi = lines.index("- name: PROXY")
    except ValueError as e:
        log_error("找不到 PROXY 组", e)
        return False
    members, i = [], gi + 1
    while i < len(lines) and not lines[i].startswith("- name:") and not lines[i].startswith("rules:"):
        if lines[i].startswith("  - "):
            members.append(lines[i])
        i += 1
    if not members:
        log_error("PROXY 组里没读到任何节点")
        return False

    lines[gi:gi] = (
        # 中转组用 url-test 而不是 select：
        # 这一跳现在承载全部境外流量，手动钉死某个节点既容易选到慢的，
        # 也会在机场调整节点时断链。交给自动测速，每 5 分钟挑一次最快的。
        [f"- name: {RELAY_GROUP}", "  type: url-test",
         "  url: http://www.gstatic.com/generate_204",
         "  interval: 300", "  tolerance: 50", "  proxies:"] + members
        + [f"- name: {GROUP_NAME}", "  type: select", "  proxies:",
           f"  - {NODE_NAME}", "  - PROXY"]
    )

    # 3) 规则目标 PROXY 全改为住宅IP；国内直连规则不动
    try:
        rs = lines.index("rules:")
    except ValueError as e:
        log_error("找不到 rules 段", e)
        return False
    changed = 0
    for idx in range(rs, len(lines)):
        ln = lines[idx]
        if not ln.startswith("- "):
            continue
        body, sep, comment = ln.partition("#")
        parts = [x.strip() for x in body.strip().split(",")]
        # 目标字段后面可能还跟 no-resolve，逐 token 精确替换
        if "PROXY" in parts[1:]:
            parts = [(GROUP_NAME if (j > 0 and x == "PROXY") else x)
                     for j, x in enumerate(parts)]
            lines[idx] = ",".join(parts) + (("  #" + comment) if sep else "")
            changed += 1
        elif parts == ["- MATCH", "FINAL"] or ln.strip() == "- MATCH,FINAL":
            lines[idx] = f"- MATCH,{GROUP_NAME}"
            changed += 1

    io.open(PROFILE, "w", encoding="utf-8").write("\n".join(lines))
    log(f"已写入：1 个节点、2 个代理组、{changed} 条规则改向住宅出口")
    return True


def ensure_udp_guard():
    """
    确保 UDP_GUARD_RULE 是 rules 段的第一条。幂等：已存在则不动。
    单独成步而不放进 apply_profile：已经套用过住宅出口的订阅文件也要补上这条。
    """
    if not os.path.exists(PROFILE):
        log_error(f"订阅文件不存在: {PROFILE}")
        return False
    lines = io.open(PROFILE, encoding="utf-8").read().split("\n")
    if UDP_GUARD_RULE in lines:
        log("境外 UDP 拦截：已存在")
        return True
    try:
        rs = lines.index("rules:")
    except ValueError as e:
        log_error("找不到 rules 段", e)
        return False
    lines.insert(rs + 1, UDP_GUARD_RULE)
    io.open(PROFILE, "w", encoding="utf-8").write("\n".join(lines))
    log("境外 UDP 拦截：已加到规则第一条（浏览器 QUIC 会退回 TCP 走住宅出口）")
    return True


def stun_public_ip(host, port):
    """向 STUN 服务器发 UDP 绑定请求，返回映射地址，即本机 UDP 流量的公网出口。拦截生效时会超时。"""
    tid = os.urandom(12)
    req = struct.pack("!HHI", 0x0001, 0, 0x2112A442) + tid
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.settimeout(3)
    try:
        s.sendto(req, (host, port))
        data, _ = s.recvfrom(2048)
    finally:
        s.close()
    i = 20
    while i + 4 <= len(data):
        t, ln = struct.unpack("!HH", data[i:i + 4])
        v = data[i + 4:i + 4 + ln]
        if t == 0x0020:  # XOR-MAPPED-ADDRESS
            ip = bytes(b ^ m for b, m in zip(v[4:8], struct.pack("!I", 0x2112A442)))
            return socket.inet_ntoa(ip)
        i += 4 + ln + (-ln % 4)
    return None


def check_udp_leak():
    """实测境外 UDP：拿不到映射地址（被拦截）才算安全；拿到任何地址都说明 UDP 在直连出网。"""
    for host, port in STUN_SERVERS:
        try:
            ip = stun_public_ip(host, port)
        except (socket.timeout, OSError):
            continue
        except Exception as e:
            log_error(f"STUN 检测异常: {host}", e)
            continue
        if ip:
            log(f"境外 UDP: 泄漏！经 {host} 看到的出口是 {ip}  ← 浏览器 HTTP/3 会绕过住宅出口")
            return False
    log("境外 UDP: 已拦截（STUN 无响应），浏览器只能走 TCP 住宅出口")
    return True


def revert_profile():
    origin = PROFILE + ".origin"
    if not os.path.exists(origin):
        log_error(f"没有订阅原样副本: {origin}")
        return False
    shutil.copyfile(origin, PROFILE)
    log("已还原为订阅原样")
    return True


def group_selection():
    """
    读出「住宅IP」组当前选中的成员。
    这个组是 select 类型，可以在 FlClash 界面里随手切到 PROXY 把住宅出口关掉，
    光看订阅文件是看不出来的——曾经因此误判成「已生效」。
    """
    try:
        con = sqlite3.connect(DB_PATH)
        row = con.execute("SELECT selected_map FROM profiles WHERE id = ?",
                          (PROFILE_ID,)).fetchone()
        con.close()
        return (json.loads(row[0]) if row and row[0] else {}).get(GROUP_NAME)
    except Exception as e:
        log_error("读取组选择失败", e)
        return None


def set_group_selection(member):
    """把「住宅IP」组钉到指定成员，避免依赖「默认取第一项」这种隐式行为。"""
    try:
        con = sqlite3.connect(DB_PATH)
        cur = con.cursor()
        row = cur.execute("SELECT selected_map FROM profiles WHERE id = ?",
                          (PROFILE_ID,)).fetchone()
        m = json.loads(row[0]) if row and row[0] else {}
        if m.get(GROUP_NAME) == member:
            con.close()
            return True
        m[GROUP_NAME] = member
        cur.execute("UPDATE profiles SET selected_map = ? WHERE id = ?",
                    (json.dumps(m, ensure_ascii=False), PROFILE_ID))
        con.commit()
        con.close()
        log(f"「{GROUP_NAME}」组已切到 {member}")
        return True
    except Exception as e:
        log_error("写入组选择失败", e)
        return False


def check():
    text = io.open(PROFILE, encoding="utf-8").read() if os.path.exists(PROFILE) else ""
    applied = NODE_NAME in text
    log(f"订阅文件: {'已套用住宅出口' if applied else '未套用（订阅原样）'}")
    guard = UDP_GUARD_RULE in text.split("\n")
    log(f"境外 UDP 拦截规则: {'有' if guard else '没有  ← 需要重跑本脚本'}")
    udp_ok = check_udp_leak()

    sel = group_selection()
    if applied:
        if sel == NODE_NAME:
            log(f"住宅IP 开关: 开（{sel}）")
        else:
            log(f"住宅IP 开关: {'关（当前走 %s）' % sel if sel else '未记录，默认取第一项'}"
                f"  ← 流量没有经过住宅出口")

    try:
        con = sqlite3.connect(DB_PATH)
        row = con.execute("SELECT auto_update, auto_update_duration_millis "
                          "FROM profiles WHERE id = ?", (PROFILE_ID,)).fetchone()
        con.close()
        if row:
            log(f"自动更新: {'开启' if row[0] else '关闭'}"
                f"{'（每 %d 分钟）' % (row[1] // 60000) if row[0] else ''}")
    except Exception as e:
        log_error("读取数据库失败", e)
    return applied and sel == NODE_NAME and guard and udp_ok


if __name__ == "__main__":
    arg = sys.argv[1] if len(sys.argv) > 1 else ""

    if arg == "--check":
        check()
        sys.exit(0)

    if not quit_flclash():
        log_error("FlClash 未能退出，配置可能不会生效")

    ok = (revert_profile() if arg == "--revert"
          else (disable_auto_update() and apply_profile() and ensure_udp_guard()
                and set_group_selection(NODE_NAME)))
    if not ok:
        log_error("操作失败，未重启 FlClash")
        sys.exit(1)

    start_flclash()
    log("FlClash 已重启")

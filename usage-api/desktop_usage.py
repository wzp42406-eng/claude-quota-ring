"""轻量记录 Claude / ChatGPT 桌面应用在前台的时间。

每分钟由 server.py 调用一次。检测失败、锁屏或空闲超过 5 分钟时不计时；
这里只保存按天汇总和上次采样时间，不保存窗口标题等内容。
"""
import datetime as dt
import re
import subprocess
import time


BUNDLES = {
    'com.anthropic.claudefordesktop': 'claude_desktop',
    'com.openai.codex': 'chatgpt_desktop',
}
IDLE_LIMIT_NS = 5 * 60 * 1_000_000_000
MAX_SAMPLE_GAP_MS = 90_000


def _run(args):
    try:
        result = subprocess.run(args, capture_output=True, text=True, timeout=5, check=False)
    except (OSError, subprocess.SubprocessError):
        return ''
    return result.stdout if result.returncode == 0 else ''


def front_bundle_id():
    """用 lsappinfo 找当前前台应用的 bundle id。"""
    front = _run(['/usr/bin/lsappinfo', 'front']).strip()
    if not front or 'NULL' in front:
        return None
    # 某些系统版本会直接带 bundle id；否则用返回的 ASN 再查一次。
    for bundle in BUNDLES:
        if bundle in front:
            return bundle
    match = re.search(r'ASN:[^\]\s]+', front)
    spec = match.group(0) if match else front
    info = _run(['/usr/bin/lsappinfo', 'info', '-only', 'bundleid', spec])
    for bundle in BUNDLES:
        if bundle in info:
            return bundle
    return None


def hid_idle_ns():
    out = _run(['/usr/sbin/ioreg', '-c', 'IOHIDSystem', '-r', '-d', '1'])
    match = re.search(r'"HIDIdleTime"\s*=\s*(\d+)', out)
    return int(match.group(1)) if match else None


def screen_locked():
    out = _run(['/usr/sbin/ioreg', '-n', 'Root', '-r', '-d', '1'])
    match = re.search(r'"IOConsoleLocked"\s*=\s*(Yes|No)', out, re.IGNORECASE)
    if not match:
        return None
    return match.group(1).lower() == 'yes'


def record_sample(state, now_ms, bundle_id, idle_ns, locked):
    """把一次采样写进 state；返回本次新增的毫秒数。"""
    previous = state.get('last_sample_ms')
    state['last_sample_ms'] = int(now_ms)
    if 'started_ms' not in state:
        # 记下采样从何时开始：collect.py 据此只给之前的桌面会话按间隔补时长。
        # 旧状态已有数据时取最早那天 0 点，宁可少补，也不和采样重复。
        days = sorted(state.get('days') or {})
        state['started_ms'] = (int(dt.datetime.fromisoformat(days[0]).astimezone().timestamp() * 1000)
                               if days else int(now_ms))
    site = BUNDLES.get(bundle_id)
    if site is None or previous is None or locked is not False or idle_ns is None or idle_ns > IDLE_LIMIT_NS:
        return 0
    elapsed = int(now_ms) - int(previous)
    if elapsed <= 0 or elapsed > MAX_SAMPLE_GAP_MS:
        return 0
    day = dt.datetime.fromtimestamp(now_ms / 1000).astimezone().date().isoformat()
    rec = state.setdefault('days', {}).setdefault(day, {}).setdefault(site, {'ms': 0})
    rec['ms'] = int(rec.get('ms', 0)) + elapsed
    return elapsed


def sample(state, now_ms=None):
    """读取一次系统状态并原地更新 state。"""
    now_ms = int(time.time() * 1000) if now_ms is None else int(now_ms)
    return record_sample(state, now_ms, front_bundle_id(), hid_idle_ns(), screen_locked())

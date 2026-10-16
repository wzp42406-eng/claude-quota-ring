#!/usr/bin/env python3
"""通过 Codex app-server 的只读 RPC 获取账户额度和 Token 用量。

不读取或导出 auth.json；认证由本机 Codex app-server 自己处理。返回值只保留
展示工作台需要的汇总字段，不包含 accountId、会话内容或访问令牌。
"""
import datetime as dt
import json
import os
import select
import shutil
import subprocess
import time
from pathlib import Path


CLIENT = {'name': 'ai-workbench', 'version': '1.0.0'}


def _codex_binary():
    candidates = (
        shutil.which('codex'),
        '/opt/homebrew/bin/codex',
        '/usr/local/bin/codex',
    )
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return candidate
    raise FileNotFoundError('找不到 codex 命令')


def _send(proc, obj):
    proc.stdin.write(json.dumps(obj, separators=(',', ':')) + '\n')
    proc.stdin.flush()


def _responses(proc, wanted, timeout):
    out = {}
    deadline = time.monotonic() + timeout
    while wanted - out.keys():
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError('Codex app-server 响应超时')
        ready, _, _ = select.select([proc.stdout], [], [], left)
        if not ready:
            raise TimeoutError('Codex app-server 响应超时')
        line = proc.stdout.readline()
        if not line:
            raise RuntimeError('Codex app-server 提前退出')
        try:
            obj = json.loads(line)
        except ValueError:
            continue
        rid = obj.get('id')
        if rid in wanted:
            if obj.get('error'):
                raise RuntimeError(f'RPC {rid}: {obj["error"]}')
            out[rid] = obj.get('result') or {}
    return out


def _window(window):
    if not isinstance(window, dict) or window.get('usedPercent') is None:
        return None
    reset = window.get('resetsAt')
    return {
        'used_percent': float(window['usedPercent']),
        'remaining_percent': max(0.0, 100.0 - float(window['usedPercent'])),
        'window_minutes': window.get('windowDurationMins'),
        'resets_at': dt.datetime.fromtimestamp(reset, dt.timezone.utc).astimezone().isoformat(timespec='seconds')
        if reset else None,
    }


def read(timeout=12):
    """返回适合落盘的精简快照；接口不可用时抛出异常，由调用方保留旧快照。"""
    proc = subprocess.Popen(
        [_codex_binary(), 'app-server', '--stdio'],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
        env=os.environ.copy(),
    )
    try:
        _send(proc, {
            'id': 1,
            'method': 'initialize',
            'params': {'clientInfo': CLIENT, 'capabilities': {'experimentalApi': True}},
        })
        _responses(proc, {1}, timeout)
        _send(proc, {'method': 'initialized'})
        _send(proc, {
            'id': 2,
            'method': 'account/rateLimits/read',
            # 0.163 的 stdio 服务仍把这个方法声明为 unit 参数；省略 params
            # 同时兼容新旧协议。响应中无需 reset-credit 明细。
        })
        _send(proc, {'id': 3, 'method': 'account/usage/read', 'params': {}})
        result = _responses(proc, {2, 3}, timeout)
        limits = result[2].get('rateLimits') or {}
        usage = result[3]
        now = dt.datetime.now().astimezone().isoformat(timespec='seconds')
        quota = {
            'five_hour': _window(limits.get('primary')),
            'seven_day': _window(limits.get('secondary')),
            'observed_at': now,
            'source': 'codex_app_server',
        }
        quota = {k: v for k, v in quota.items() if v is not None}
        summary = usage.get('summary') or {}
        buckets = []
        for item in usage.get('dailyUsageBuckets') or []:
            day, tokens = item.get('startDate'), item.get('tokens')
            if isinstance(day, str) and isinstance(tokens, int):
                buckets.append({'date': day, 'tokens': tokens})
        return {
            'updated_at': now,
            'quota': quota,
            'token_usage': {
                'lifetime_tokens': summary.get('lifetimeTokens'),
                'peak_daily_tokens': summary.get('peakDailyTokens'),
                'longest_running_turn_seconds': summary.get('longestRunningTurnSec'),
                'current_streak_days': summary.get('currentStreakDays'),
                'longest_streak_days': summary.get('longestStreakDays'),
                'daily': buckets,
            },
        }
    finally:
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=2)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=2)


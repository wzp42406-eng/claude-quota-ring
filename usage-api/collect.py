"""读取本机终端 AI 工具自己写的会话记录，按天汇总使用时长和 token（实际值，不是估算）。

- Claude Code：~/.claude/projects/**/*.jsonl，每条回复的 message.usage；
  entrypoint=claude-desktop 的 Code 标签页 token 单独归入桌面端
- Codex：~/.codex/sessions/**/*.jsonl，token_count 事件的 last_token_usage 和 rate_limits；
  originator 带 desktop 的会话同样与终端拆分

增量读取：记住每个文件读到的位置，只读新增的完整行。
tokens = 未命中缓存的输入 + 写缓存 + 输出；命中缓存的输入另记为 cache_read。
时长 = 同一会话里相邻两条记录间隔不超过 5 分钟的部分相加。
"""
import datetime as dt
import json
from pathlib import Path

HOME = Path.home()
SOURCES = {
    'claude_code': HOME / '.claude/projects',
    'codex': HOME / '.codex/sessions',
}
GAP_MS = 5 * 60 * 1000
COLLECTOR_VERSION = 2


def _ts(value):
    """ISO 时间或秒级时间戳 → (毫秒, 本地日期字符串)"""
    if isinstance(value, (int, float)):
        t = dt.datetime.fromtimestamp(value, dt.timezone.utc)
    else:
        t = dt.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
    return int(t.timestamp() * 1000), t.astimezone().date().isoformat()


def _bucket(days, day, site):
    rec = days.setdefault(day, {}).setdefault(site, {'ms': 0, 'tok': 0, 'cache': 0})
    rec.setdefault('cache', 0)
    return rec


def _add_time(days, site, st, ms, day):
    last = st.get('last_ms')
    if last is not None and 0 < ms - last <= GAP_MS:
        _bucket(days, day, site)['ms'] += ms - last
    if last is None or ms > last:
        st['last_ms'] = ms


def _claude_line(obj, days, st, quota):
    ts = obj.get('timestamp')
    if not ts:
        return
    ms, day = _ts(ts)
    desktop = obj.get('entrypoint') == 'claude-desktop'
    site = 'claude_desktop_code' if desktop else 'claude_code'
    # 桌面软件的时长由前台应用采样统计；会话相邻事件不能再重复计时。
    if not desktop:
        _add_time(days, site, st, ms, day)
    msg = obj.get('message') if obj.get('type') == 'assistant' else None
    usage = isinstance(msg, dict) and msg.get('usage')
    if not usage:
        return
    # 一条回复按内容块拆成多行，usage 重复：按消息 id 只计一次
    mid = msg.get('id') or obj.get('requestId') or obj.get('uuid')
    seen = st.setdefault('ids', [])
    if mid in seen:
        return
    seen.append(mid)
    del seen[:-50]
    b = _bucket(days, day, site)
    b['tok'] += (usage.get('input_tokens') or 0) + (usage.get('cache_creation_input_tokens') or 0) \
        + (usage.get('output_tokens') or 0)
    b['cache'] += usage.get('cache_read_input_tokens') or 0


def _codex_line(obj, days, st, quota):
    ts = obj.get('timestamp')
    if not ts:
        return
    p = obj.get('payload') or {}
    if obj.get('type') == 'session_meta':
        originator = str(p.get('originator') or '').lower()
        st['desktop'] = 'desktop' in originator
    ms, day = _ts(ts)
    site = 'codex_desktop_code' if st.get('desktop') else 'codex'
    if not st.get('desktop'):
        _add_time(days, site, st, ms, day)
    if obj.get('type') != 'event_msg' or p.get('type') != 'token_count':
        return
    info = p.get('info') or {}
    total = (info.get('total_token_usage') or {}).get('total_tokens')
    last = info.get('last_token_usage') or {}
    # 同一次调用的 token_count 可能发多次：累计总数没变就不再计
    if total is not None and total != st.get('total') and last:
        st['total'] = total
        cached = last.get('cached_input_tokens') or 0
        b = _bucket(days, day, site)
        b['tok'] += max(0, (last.get('input_tokens') or 0) - cached) + (last.get('output_tokens') or 0)
        b['cache'] += cached
    rl = p.get('rate_limits') or {}
    for key, kind in (('primary', 'five_hour'), ('secondary', 'seven_day')):
        w = rl.get(key)
        if not w or w.get('used_percent') is None:
            continue
        cur = quota.get(kind)
        if cur and cur['observed_ms'] > ms:
            continue
        reset = w.get('resets_at')
        quota[kind] = {
            'used_percent': w['used_percent'],
            'resets_at': _iso(reset) if reset else None,
            'window_minutes': w.get('window_minutes'),
            'observed_ms': ms,
        }


def _iso(epoch):
    return dt.datetime.fromtimestamp(epoch, dt.timezone.utc).astimezone().isoformat(timespec='seconds')


PARSERS = {'claude_code': _claude_line, 'codex': _codex_line}


def scan(state):
    """state: {'files': {...}, 'days': {...}, 'quota': {'codex': {...}}}，原地更新；返回是否有新数据。"""
    changed = False
    if state.get('collector_version') != COLLECTOR_VERSION:
        # v2 开始按 entrypoint 拆分 Claude CLI 与桌面 Code。旧汇总无法安全相减，
        # 因此只在升级时从会话记录重建一次，避免历史数据重复。
        state.clear()
        state['collector_version'] = COLLECTOR_VERSION
        changed = True
    files = state.setdefault('files', {})
    days = state.setdefault('days', {})
    quotas = state.setdefault('quota', {})
    for site, root in SOURCES.items():
        if not root.exists():
            continue
        quota = quotas.setdefault(site, {}) if site == 'codex' else {}
        parse = PARSERS[site]
        for path in root.rglob('*.jsonl'):
            key = str(path)
            try:
                size = path.stat().st_size
            except OSError:
                continue
            st = files.setdefault(key, {'offset': 0})
            if size < st['offset']:  # 文件被重写：从头再读
                st.clear()
                st['offset'] = 0
            if size == st['offset']:
                continue
            with open(path, 'rb') as f:
                f.seek(st['offset'])
                chunk = f.read()
            end = chunk.rfind(b'\n')
            if end < 0:
                continue
            for raw in chunk[:end].splitlines():
                try:
                    parse(json.loads(raw), days, st, quota)
                except (ValueError, TypeError, AttributeError, OverflowError):
                    continue
            st['offset'] += end + 1
            changed = True
    return changed

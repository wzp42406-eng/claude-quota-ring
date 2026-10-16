#!/usr/bin/env python3
"""本机 AI 用量 API：汇总浏览器扩展（claude.ai / chatgpt.com）和终端（Claude Code / Codex）的用量与额度，给个人工作台等读取。

只监听 127.0.0.1，不对外网开放。读取要带专属密钥：
    curl -H "Authorization: Bearer <密钥>" http://127.0.0.1:8787/api/usage

    python3 server.py            启动（默认端口 8787）
    python3 server.py --key      显示专属密钥
    python3 server.py --new-key  重新生成密钥（旧密钥立即失效）
    python3 server.py --summary  在终端打印用量与额度汇总
"""
import argparse
import datetime as dt
import json
import os
import secrets
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import collect

DATA_DIR = Path(os.environ.get('AI_USAGE_DIR', Path.home() / 'Library/Application Support/ai-usage'))
DATA = DATA_DIR / 'usage.json'
CONFIG = DATA_DIR / 'config.json'
WEB = ('claude', 'chatgpt')          # 浏览器扩展
CLI = ('claude_code', 'codex')       # 终端会话记录
SOURCES = WEB + CLI
CLI_STATE = DATA_DIR / 'cli_state.json'
QUOTA = DATA_DIR / 'quota.json'
PAGE = Path(__file__).resolve().parent.parent / 'site' / 'index.html'
PERIODS = ('day', 'week', 'month', 'year', 'all')
LOCK = threading.Lock()


def load(path, default):
    try:
        return json.loads(path.read_text('utf-8'))
    except (OSError, ValueError):
        return default


def save(path, obj):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f'.{path.name}.{os.getpid()}.{threading.get_ident()}.tmp')
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), 'utf-8')
    os.chmod(tmp, 0o600)
    tmp.replace(path)


def api_key(regenerate=False):
    cfg = load(CONFIG, {})
    if regenerate or not cfg.get('key'):
        cfg['key'] = 'aiu_' + secrets.token_urlsafe(24)
        save(CONFIG, cfg)
    return cfg['key']


def merge(days):
    """扩展是网页用量的唯一数据源，但扩展被重装时本地存储会清空：按天按站点取较大值，旧数据不会被冲掉。"""
    with LOCK:
        store = load(DATA, {'days': {}})
        for day, rec in days.items():
            try:
                dt.date.fromisoformat(day)
            except (TypeError, ValueError):
                continue
            cur = store['days'].setdefault(day, {})
            for site in WEB:
                new = (rec or {}).get(site) or {}
                old = cur.get(site) or {}
                cur[site] = {
                    'ms': max(int(old.get('ms', 0)), int(new.get('ms', 0) or 0)),
                    'tok': max(int(old.get('tok', 0)), int(new.get('tok', 0) or 0)),
                }
        store['updated_at'] = now_iso()
        save(DATA, store)


def now_iso():
    return dt.datetime.now().astimezone().isoformat(timespec='seconds')


# ---------- 终端 CLI：读 Claude Code / Codex 自己的会话记录 ----------
_last_scan = 0.0


def scan_cli(force=False):
    """最多 10 秒扫一次；只读新增内容，通常几毫秒。"""
    global _last_scan
    if not force and time.monotonic() - _last_scan < 10:
        return
    with LOCK:
        _last_scan = time.monotonic()
        state = load(CLI_STATE, {})
        if collect.scan(state):
            state['updated_at'] = now_iso()
            save(CLI_STATE, state)


def set_quota(source, limits):
    """Claude 额度：Claude Code 插件或浏览器扩展报来的 5 小时 / 7 天窗口。"""
    with LOCK:
        q = load(QUOTA, {})
        cur = q.setdefault(source, {})
        for l in limits if isinstance(limits, list) else []:
            kind = l.get('kind')
            used = l.get('percentUsed', l.get('utilization'))
            if kind not in ('five_hour', 'seven_day') or not isinstance(used, (int, float)):
                continue
            cur[kind] = {'used_percent': round(float(used), 1), 'resets_at': l.get('resetsAt') or l.get('resets_at'),
                         'observed_at': now_iso()}
        save(QUOTA, q)


def quota_view():
    out = {}
    q = load(QUOTA, {})
    codex = load(CLI_STATE, {}).get('quota', {}).get('codex', {})
    for source, windows in (('claude', q.get('claude', {})), ('codex', codex)):
        out[source] = {}
        for kind, w in windows.items():
            seen = w.get('observed_at') or (dt.datetime.fromtimestamp(w['observed_ms'] / 1000).astimezone()
                                            .isoformat(timespec='seconds') if w.get('observed_ms') else None)
            out[source][kind] = {
                'used_percent': w['used_percent'],
                'remaining_percent': max(0, round(100 - w['used_percent'], 1)),
                'resets_at': w.get('resets_at'),
                'observed_at': seen,
            }
    return out


# ---------- 汇总 ----------
def all_days():
    """{日期: {来源: {ms, tok, cache}}}，网页（扩展）和终端（会话记录）合在一起"""
    days = {}
    for day, rec in load(DATA, {'days': {}})['days'].items():
        days.setdefault(day, {}).update({s: v for s, v in rec.items() if s in WEB})
    for day, rec in load(CLI_STATE, {}).get('days', {}).items():
        days.setdefault(day, {}).update({s: v for s, v in rec.items() if s in CLI})
    return days


def period_start(pid, today):
    if pid == 'day':
        return today
    if pid == 'week':  # 周一开始
        return today - dt.timedelta(days=today.weekday())
    if pid == 'month':
        return today.replace(day=1)
    if pid == 'year':
        return today.replace(month=1, day=1)
    return dt.date.min


def entry(ms, tok, cache=None):
    e = {'minutes': round(ms / 60000, 1), 'tokens': tok}
    if cache is not None:
        e['cache_read_tokens'] = cache
    return e


def group(rec, names):
    ms = tok = cache = 0
    for s in names:
        v = rec.get(s) or {}
        ms += v.get('ms', 0)
        tok += v.get('tok', 0)
        cache += v.get('cache', 0)
    return ms, tok, cache


def row(rec):
    out = {}
    for s in SOURCES:
        ms, tok, cache = group(rec, [s])
        out[s] = entry(ms, tok, cache if s in CLI else None)
    out['web_total'] = entry(*group(rec, WEB)[:2])
    out['cli_total'] = entry(*group(rec, CLI))
    out['total'] = entry(*group(rec, SOURCES)[:2])
    return out


def summary():
    scan_cli()
    days = all_days()
    today = dt.date.today()
    periods = {}
    for pid in PERIODS:
        start = period_start(pid, today).isoformat()
        acc = {}
        for day, rec in days.items():
            if start <= day <= today.isoformat():
                for s, v in rec.items():
                    a = acc.setdefault(s, {'ms': 0, 'tok': 0, 'cache': 0})
                    a['ms'] += v.get('ms', 0)
                    a['tok'] += v.get('tok', 0)
                    a['cache'] += v.get('cache', 0)
        periods[pid] = row(acc)
        periods[pid]['from'] = None if pid == 'all' else start
    return {
        'updated_at': now_iso(),
        'sources': {
            'claude': '网页 claude.ai（扩展统计，token 为估算）',
            'chatgpt': '网页 chatgpt.com（扩展统计，token 为估算）',
            'claude_code': 'Claude Code 终端/桌面 Code 页（会话记录，token 为实际值）',
            'codex': 'Codex CLI / 桌面（会话记录，token 为实际值）',
        },
        'note': 'tokens = 未命中缓存的输入 + 写缓存 + 输出；cache_read_tokens 为命中缓存的输入，另计',
        'quota': quota_view(),
        'periods': periods,
    }


def daily(qs):
    scan_cli()
    days = all_days()
    lo = (qs.get('from') or [''])[0]
    hi = (qs.get('to') or ['9999-12-31'])[0]
    return {'days': [{'date': d, **row(days[d])} for d in sorted(days) if lo <= d <= hi]}


class Handler(BaseHTTPRequestHandler):
    server_version = 'ai-usage/1.0'

    def log_message(self, *_):
        pass

    def cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Headers', 'Authorization, Content-Type')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        # https 网页（如在线工作台）访问本机地址时 Chrome 会先问这一项
        self.send_header('Access-Control-Allow-Private-Network', 'true')

    def reply(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.cors()
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def authorized(self):
        got = self.headers.get('Authorization', '')
        return secrets.compare_digest(got, f'Bearer {api_key()}')

    def page(self):
        try:
            body = PAGE.read_bytes()
        except OSError:
            return self.reply(404, {'error': 'workbench.html missing'})
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Frame-Options', 'DENY')
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/health':
            return self.reply(200, {'ok': True})
        if url.path in ('/', '/index.html'):
            return self.page()
        if url.path == '/data.json':  # 与公开网站同一份快照，本机打开工作台时用
            return self.reply(200, public_snapshot())
        if url.path not in ('/api/usage', '/api/usage/daily'):
            return self.reply(404, {'error': 'not found'})
        if not self.authorized():
            return self.reply(401, {'error': '需要 Authorization: Bearer <密钥>'})
        if url.path == '/api/usage':
            return self.reply(200, summary())
        return self.reply(200, daily(parse_qs(url.query)))

    def body(self):
        n = int(self.headers.get('Content-Length', 0))
        if n > 5_000_000:
            raise ValueError('too large')
        obj = json.loads(self.rfile.read(n) or b'{}')
        if not isinstance(obj, dict):
            raise ValueError
        return obj

    def do_POST(self):
        path = urlparse(self.path).path
        if path not in ('/api/sync', '/api/quota'):
            return self.reply(404, {'error': 'not found'})
        # 写入只接受浏览器扩展（Origin 是 chrome-extension://，网页做不到）或带密钥的本机程序（Claude Code 插件）
        from_ext = self.headers.get('Origin', '').startswith('chrome-extension://')
        if not (from_ext or self.authorized()):
            return self.reply(403, {'error': 'only the browser extension or a holder of the key may write'})
        try:
            obj = self.body()
        except ValueError:
            return self.reply(400, {'error': 'bad json'})
        if path == '/api/quota':
            if obj.get('source') != 'claude':
                return self.reply(400, {'error': 'source must be claude'})
            set_quota('claude', obj.get('limits'))
            return self.reply(200, {'ok': True})
        if not from_ext:
            return self.reply(403, {'error': 'only the browser extension may sync'})
        days = obj.get('days') or {}
        if not isinstance(days, dict):
            return self.reply(400, {'error': 'bad json'})
        merge(days)
        if obj.get('quota'):
            set_quota('claude', obj['quota'])
        return self.reply(200, {'ok': True, 'days': len(days)})


def public_snapshot(days=60):
    """公开网站用的数据：只有按天的时长、token 和额度百分比，没有密钥、路径或对话内容。"""
    s = summary()
    start = (dt.date.today() - dt.timedelta(days=days - 1)).isoformat()
    return {
        'updated_at': s['updated_at'],
        'note': s['note'],
        'quota': s['quota'],
        'periods': s['periods'],
        'daily': daily({'from': [start]})['days'],
    }


def fmt_min(m):
    m = int(m)
    return f'{m // 60}h{m % 60:02d}m' if m >= 60 else f'{m}m'


def fmt_tok(n):
    return f'{n / 1e6:.1f}M' if n >= 1e6 else f'{n / 1e3:.1f}k' if n >= 1e3 else str(n)


def pad(text, width, right=False):
    """按显示宽度补空格：中文算两格"""
    w = sum(2 if ord(c) > 0x2E80 else 1 for c in text)
    fill = ' ' * max(0, width - w)
    return fill + text if right else text + fill


def print_summary():
    scan_cli(force=True)
    d = summary()
    names = {'claude': 'Claude 网页', 'chatgpt': 'ChatGPT 网页', 'claude_code': 'Claude Code', 'codex': 'Codex',
             'total': '合计'}
    labels = {'day': '今日', 'week': '本周', 'month': '本月', 'year': '今年', 'all': '累计'}
    print(pad('', 13) + ''.join(pad(labels[p], 15, True) for p in PERIODS))
    for s in (*SOURCES, 'total'):
        cells = [f"{fmt_min(d['periods'][p][s]['minutes'])} {fmt_tok(d['periods'][p][s]['tokens'])}" for p in PERIODS]
        print(pad(names[s], 13) + ''.join(pad(c, 15, True) for c in cells))
    for src, windows in d['quota'].items():
        if windows:
            parts = [f"{'5h' if k == 'five_hour' else '7d'} 剩 {w['remaining_percent']:g}%" for k, w in windows.items()]
            print(pad(f"额度 {'Claude' if src == 'claude' else 'Codex'}", 13) + ' · '.join(parts))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=int(os.environ.get('AI_USAGE_PORT', 8787)))
    ap.add_argument('--key', action='store_true', help='显示专属密钥')
    ap.add_argument('--new-key', action='store_true', help='重新生成专属密钥')
    ap.add_argument('--summary', action='store_true', help='在终端打印用量与额度汇总')
    args = ap.parse_args()
    if args.key or args.new_key:
        print(api_key(regenerate=args.new_key))
        return
    if args.summary:
        print_summary()
        return
    api_key()

    def rescan():
        while True:
            try:
                scan_cli(force=True)
            except Exception as err:  # 别让后台扫描的意外打断服务
                print(f'scan failed: {err}', flush=True)
            time.sleep(30)

    threading.Thread(target=rescan, daemon=True).start()
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'AI 用量 API 已启动：http://127.0.0.1:{args.port}/api/usage （数据在 {DATA}）', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()

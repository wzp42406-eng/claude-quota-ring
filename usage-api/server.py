#!/usr/bin/env python3
"""本机 AI 用量 API：接收浏览器扩展同步来的按天记录，给个人工作台等读取。

只监听 127.0.0.1，不对外网开放。读取要带专属密钥：
    curl -H "Authorization: Bearer <密钥>" http://127.0.0.1:8787/api/usage

    python3 server.py            启动（默认端口 8787）
    python3 server.py --key      显示专属密钥
    python3 server.py --new-key  重新生成密钥（旧密钥立即失效）
"""
import argparse
import datetime as dt
import json
import os
import secrets
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DATA_DIR = Path(os.environ.get('AI_USAGE_DIR', Path.home() / 'Library/Application Support/ai-usage'))
DATA = DATA_DIR / 'usage.json'
CONFIG = DATA_DIR / 'config.json'
SITES = ('claude', 'chatgpt')
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
    """扩展是唯一数据源，但扩展被重装时本地存储会清空：按天按站点取较大值，旧数据不会被冲掉。"""
    with LOCK:
        store = load(DATA, {'days': {}})
        for day, rec in days.items():
            try:
                dt.date.fromisoformat(day)
            except (TypeError, ValueError):
                continue
            cur = store['days'].setdefault(day, {})
            for site in SITES:
                new = (rec or {}).get(site) or {}
                old = cur.get(site) or {}
                cur[site] = {
                    'ms': max(int(old.get('ms', 0)), int(new.get('ms', 0) or 0)),
                    'tok': max(int(old.get('tok', 0)), int(new.get('tok', 0) or 0)),
                }
        store['updated_at'] = dt.datetime.now().astimezone().isoformat(timespec='seconds')
        save(DATA, store)


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


def entry(ms, tok):
    return {'minutes': round(ms / 60000, 1), 'tokens': tok}


def summary():
    store = load(DATA, {'days': {}})
    today = dt.date.today()
    out = {}
    for pid in PERIODS:
        start = period_start(pid, today).isoformat()
        sums = {s: [0, 0] for s in SITES}
        for day, rec in store['days'].items():
            if start <= day <= today.isoformat():
                for s in SITES:
                    sums[s][0] += (rec.get(s) or {}).get('ms', 0)
                    sums[s][1] += (rec.get(s) or {}).get('tok', 0)
        out[pid] = {s: entry(*sums[s]) for s in SITES}
        out[pid]['total'] = entry(sum(v[0] for v in sums.values()), sum(v[1] for v in sums.values()))
        out[pid]['from'] = None if pid == 'all' else start
    return {
        'updated_at': store.get('updated_at'),
        'note': 'tokens 为按对话文字估算；minutes 为页面前台且有操作的时长',
        'periods': out,
    }


def daily(qs):
    store = load(DATA, {'days': {}})
    lo = (qs.get('from') or [''])[0]
    hi = (qs.get('to') or ['9999-12-31'])[0]
    rows = []
    for day in sorted(store['days']):
        if lo <= day <= hi:
            rec = store['days'][day]
            row = {'date': day}
            for s in SITES:
                v = rec.get(s) or {}
                row[s] = entry(v.get('ms', 0), v.get('tok', 0))
            row['total'] = entry(sum((rec.get(s) or {}).get('ms', 0) for s in SITES),
                                 sum((rec.get(s) or {}).get('tok', 0) for s in SITES))
            rows.append(row)
    return {'days': rows}


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

    def do_GET(self):
        url = urlparse(self.path)
        if url.path == '/health':
            return self.reply(200, {'ok': True})
        if url.path not in ('/api/usage', '/api/usage/daily'):
            return self.reply(404, {'error': 'not found'})
        if not self.authorized():
            return self.reply(401, {'error': '需要 Authorization: Bearer <密钥>'})
        if url.path == '/api/usage':
            return self.reply(200, summary())
        return self.reply(200, daily(parse_qs(url.query)))

    def do_POST(self):
        if urlparse(self.path).path != '/api/sync':
            return self.reply(404, {'error': 'not found'})
        # 只接受浏览器扩展写入：网页发来的请求 Origin 是 http(s)://，扩展是 chrome-extension://
        if not self.headers.get('Origin', '').startswith('chrome-extension://'):
            return self.reply(403, {'error': 'only the browser extension may sync'})
        try:
            n = int(self.headers.get('Content-Length', 0))
            if n > 5_000_000:
                return self.reply(413, {'error': 'too large'})
            days = json.loads(self.rfile.read(n) or b'{}').get('days') or {}
            if not isinstance(days, dict):
                raise ValueError
        except ValueError:
            return self.reply(400, {'error': 'bad json'})
        merge(days)
        return self.reply(200, {'ok': True, 'days': len(days)})


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--port', type=int, default=int(os.environ.get('AI_USAGE_PORT', 8787)))
    ap.add_argument('--key', action='store_true', help='显示专属密钥')
    ap.add_argument('--new-key', action='store_true', help='重新生成专属密钥')
    args = ap.parse_args()
    if args.key or args.new_key:
        print(api_key(regenerate=args.new_key))
        return
    api_key()
    srv = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
    print(f'AI 用量 API 已启动：http://127.0.0.1:{args.port}/api/usage （数据在 {DATA}）', flush=True)
    srv.serve_forever()


if __name__ == '__main__':
    main()

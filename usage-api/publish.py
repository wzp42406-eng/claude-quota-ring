#!/usr/bin/env python3
"""把工作台发布到公开网站（GitHub Pages）：上传 site/index.html 和最新的用量快照 data.json。

由 launchd 每 12 小时运行一次（install.sh 安装），也可以手动运行：
    python3 publish.py            发布
    python3 publish.py --dry-run  只生成 data.json 看看，不上传

用本机 gh 已登录的账号写仓库；内容没变的文件不会重复提交。
"""
import argparse
import base64
import json
import shutil
import subprocess
import sys
from pathlib import Path

import server

REPO = 'wzp42406-eng/ai-workbench'
SITE = Path(__file__).resolve().parent.parent / 'site'


def gh():
    for p in (shutil.which('gh'), '/opt/homebrew/bin/gh', '/usr/local/bin/gh'):
        if p and Path(p).exists():
            return p
    sys.exit('找不到 gh 命令')


def remote_sha(path):
    r = subprocess.run([gh(), 'api', f'repos/{REPO}/contents/{path}', '--jq', '.sha'],
                       capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None


def remote_text(path):
    r = subprocess.run([gh(), 'api', f'repos/{REPO}/contents/{path}', '-H', 'Accept: application/vnd.github.raw'],
                       capture_output=True, text=True)
    return r.stdout if r.returncode == 0 else None


def put(path, text, message):
    if remote_text(path) == text:
        print(f'{path}: 没有变化')
        return
    body = {'message': message, 'content': base64.b64encode(text.encode('utf-8')).decode()}
    sha = remote_sha(path)
    if sha:
        body['sha'] = sha
    r = subprocess.run([gh(), 'api', '--method', 'PUT', f'repos/{REPO}/contents/{path}', '--input', '-'],
                       input=json.dumps(body), capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit(f'{path}: 上传失败 {r.stderr.strip()}')
    print(f'{path}: 已更新')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dry-run', action='store_true')
    args = ap.parse_args()
    server.scan_cli(force=True)
    data = json.dumps(server.public_snapshot(), ensure_ascii=False, indent=1) + '\n'
    if args.dry_run:
        print(data)
        return
    put('index.html', (SITE / 'index.html').read_text('utf-8'), '更新工作台页面')
    put('data.json', data, f"更新用量数据 {json.loads(data)['updated_at']}")


if __name__ == '__main__':
    main()

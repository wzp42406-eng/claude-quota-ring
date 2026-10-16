"""工作台的英语板块：词卡 + 间隔复习（莱特纳盒子）。

每张卡在第 0～7 盒；记得 → 进一盒，模糊 → 留在原盒但隔天再来，忘了 → 回第 1 盒、今天再来。
每盒的复习间隔（天）见 INTERVALS。每天最多引入 NEW_PER_DAY 张新卡。
"""
import datetime as dt
import json
import secrets
from pathlib import Path

INTERVALS = [0, 1, 2, 4, 7, 15, 30, 60]
NEW_PER_DAY = 10
SEED = Path(__file__).with_name('english_seed.json')


def today():
    return dt.date.today().isoformat()


def plus(days):
    return (dt.date.today() + dt.timedelta(days=days)).isoformat()


def fresh():
    cards = json.loads(SEED.read_text('utf-8')) if SEED.exists() else []
    return {'cards': [new_card(**c) for c in cards], 'log': {}}


def new_card(front, back, example='', note=''):
    return {
        'id': secrets.token_hex(4), 'front': front.strip(), 'back': back.strip(),
        'example': example.strip(), 'note': note.strip(),
        'box': 0, 'due': None, 'added': today(), 'reviews': 0, 'lapses': 0,
    }


def queue(data):
    """今天要做的卡：到期的旧卡（越久没复习越靠前），再补当天额度内的新卡；今天刚忘的排最后，隔一会儿再见。"""
    t = today()
    due = sorted((c for c in data['cards'] if c['box'] > 0 and c['due'] and c['due'] <= t), key=lambda c: c['due'])
    log = data['log'].get(t, {})
    room = max(0, NEW_PER_DAY - log.get('new', 0))
    new = [c for c in data['cards'] if c['box'] == 0][:room]
    retry = [c for c in due if c.get('last') == t]
    return [c for c in due if c.get('last') != t] + new + retry


def streak(data):
    days, d = 0, dt.date.today()
    if not data['log'].get(d.isoformat(), {}).get('reviews'):
        d -= dt.timedelta(days=1)  # 今天还没学不算断
    while data['log'].get(d.isoformat(), {}).get('reviews'):
        days += 1
        d -= dt.timedelta(days=1)
    return days


def view(data):
    q = queue(data)
    t = today()
    log = data['log'].get(t, {})
    week = [(dt.date.today() - dt.timedelta(days=i)).isoformat() for i in range(6, -1, -1)]
    return {
        'queue': q,
        'stats': {
            'due': len(q),
            'reviewed_today': log.get('reviews', 0),
            'new_today': log.get('new', 0),
            'streak': streak(data),
            'total': len(data['cards']),
            'mastered': sum(1 for c in data['cards'] if c['box'] >= 5),
            'week': [{'date': d, 'reviews': data['log'].get(d, {}).get('reviews', 0)} for d in week],
        },
        'cards': sorted(data['cards'], key=lambda c: c['added'], reverse=True),
    }


def review(data, card_id, grade):
    """grade: again（忘了）/ hard（模糊）/ good（记得）"""
    card = next((c for c in data['cards'] if c['id'] == card_id), None)
    if not card or grade not in ('again', 'hard', 'good'):
        raise KeyError(card_id)
    t = today()
    log = data['log'].setdefault(t, {'reviews': 0, 'new': 0})
    if card['box'] == 0:
        log['new'] = log.get('new', 0) + 1
    log['reviews'] = log.get('reviews', 0) + 1
    card['reviews'] += 1
    if grade == 'again':
        card['box'] = 1
        card['lapses'] += 1
        card['due'] = t
    elif grade == 'hard':
        card['box'] = max(1, card['box'])
        card['due'] = plus(1)
    else:
        card['box'] = min(len(INTERVALS) - 1, card['box'] + 1)
        card['due'] = plus(INTERVALS[card['box']])
    card['last'] = t
    return card


def add(data, front, back, example='', note=''):
    if not front.strip() or not back.strip():
        raise ValueError('front and back are required')
    if any(c['front'].lower() == front.strip().lower() for c in data['cards']):
        raise ValueError('already in the deck')
    card = new_card(front, back, example, note)
    data['cards'].insert(0, card)
    return card


def remove(data, card_id):
    before = len(data['cards'])
    data['cards'] = [c for c in data['cards'] if c['id'] != card_id]
    if len(data['cards']) == before:
        raise KeyError(card_id)

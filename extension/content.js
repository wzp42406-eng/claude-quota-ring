// 名字右侧的小浮层：Claude 额度环（仅 claude.ai）+ 今日 AI 使用时长与 token（claude.ai / chatgpt.com）。
// 额度只请求 claude.ai 自己的接口；用量只在本机统计、存在扩展本地存储里，不上传。
(() => {
  const SITE = location.hostname.endsWith('claude.ai') ? 'claude' : 'chatgpt'
  const SITE_NAME = { claude: 'Claude', chatgpt: 'ChatGPT' }

  const ADAPTERS = {
    claude: {
      plan: /(Free|Pro|Max|Team|Enterprise)\b/,
      accountButton: () => document.querySelector('[data-testid="user-menu-button"]'),
      userMessages: () => document.querySelectorAll('[data-testid="user-message"]'),
      assistantMessages: () => document.querySelectorAll('[data-is-streaming]'),
      generating: () => !!document.querySelector('[data-is-streaming="true"]'),
    },
    chatgpt: {
      plan: /(Free|Go|Plus|Pro|Team|Business|Enterprise)\b/,
      accountButton: () => document.querySelector('[data-testid="accounts-profile-button"]'),
      userMessages: () => document.querySelectorAll('[data-message-author-role="user"]'),
      assistantMessages: () => document.querySelectorAll('[data-message-author-role="assistant"]'),
      generating: () => !!document.querySelector(
        '[data-testid="stop-button"], button[aria-label*="Stop" i], .result-streaming'),
    },
  }
  const site = ADAPTERS[SITE]
  document.documentElement.dataset.cqSite = SITE

  const el = (tag, cls, text) => {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }

  // ======================================================================
  // 额度（仅 claude.ai）
  // ======================================================================
  const QUOTA_MS = 2 * 60 * 1000
  const LABELS = { five_hour: '5 小时额度', seven_day: '7 天额度' }
  let usage = null
  let fetchedAt = 0
  let orgId = null

  async function getJson(path) {
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  }

  async function refreshQuota() {
    if (SITE !== 'claude') return
    try {
      if (!orgId) {
        const orgs = await getJson('/api/organizations')
        const org = orgs.find(o => (o.capabilities || []).includes('chat')) || orgs[0]
        orgId = org && org.uuid
      }
      if (!orgId) return
      usage = await getJson(`/api/organizations/${orgId}/usage`)
      fetchedAt = Date.now()
      render()
    } catch {
      /* 未登录或接口变化：静默，下次再试 */
    }
  }

  const windows = () =>
    ['five_hour', 'seven_day']
      .map(k => usage && usage[k] && typeof usage[k].utilization === 'number'
        ? { kind: k, used: usage[k].utilization, resetsAt: usage[k].resets_at }
        : null)
      .filter(Boolean)

  const left = used => Math.max(0, Math.min(100, Math.round(100 - used)))

  function untilReset(iso) {
    if (!iso) return ''
    const m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 60000))
    if (m >= 1440) {
      const d = new Date(iso)
      const wd = '日一二三四五六'[d.getDay()]
      return `周${wd} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 重置`
    }
    if (m >= 60) return `${Math.floor(m / 60)} 小时 ${m % 60} 分后重置`
    return `${m} 分钟后重置`
  }

  // ======================================================================
  // 用量统计：使用时长 + token 估算
  // ======================================================================
  const TICK_MS = 1000
  const FLUSH_MS = 15000
  const IDLE_MS = 3 * 60 * 1000 // 3 分钟无操作且没在生成回复，就不再计时

  const pad = n => String(n).padStart(2, '0')
  const dayKey = (t = Date.now()) => {
    const d = new Date(t)
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  }

  // 中日韩字符约 1 字 1 token，其他文字约 4 字符 1 token；只是估算
  function estimateTokens(text) {
    if (!text) return 0
    const cjk = (text.match(/[぀-ヿ㐀-鿿가-힯豈-﫿＀-￯]/g) || []).length
    const rest = text.replace(/\s+/g, ' ').trim().length - cjk
    return Math.round(cjk + Math.max(0, rest) / 4)
  }

  let stored = {}            // 全部按天记录：{ 'YYYY-MM-DD': { claude: {ms,tok}, chatgpt: {ms,tok} } }
  let pending = { ms: 0, tok: 0, day: dayKey() }
  let lastInput = Date.now()
  let lastTick = Date.now()
  let wasGenerating = false
  const counted = new WeakSet()

  const alive = () => { try { return !!chrome.runtime?.id } catch { return false } }

  function flush() {
    if (!pending.ms && !pending.tok) return
    if (!alive()) return
    const msg = { type: 'usage', site: SITE, day: pending.day, ms: Math.round(pending.ms), tok: pending.tok }
    try {
      chrome.runtime.sendMessage(msg).catch(() => {})
      pending = { ms: 0, tok: 0, day: dayKey() }
    } catch { /* 扩展已重载 */ }
  }

  function addPending(ms, tok) {
    if (pending.day !== dayKey()) {
      flush() // 跨零点：先把昨天的写掉
      pending = { ms: 0, tok: 0, day: dayKey() }
    }
    pending.ms += ms
    pending.tok += tok
  }

  function countOnce(node) {
    if (!node || counted.has(node)) return
    counted.add(node)
    const tok = estimateTokens(node.textContent || '')
    if (tok) { addPending(0, tok); render() }
  }

  const lastOf = list => (list.length ? list[list.length - 1] : null)

  // 只统计在本页实时发出/生成的消息：打开历史对话不会重复计数
  function trackMessages() {
    const gen = site.generating()
    if (gen && !wasGenerating) countOnce(lastOf(site.userMessages()))
    if (!gen && wasGenerating) countOnce(lastOf(site.assistantMessages()))
    wasGenerating = gen
    return gen
  }

  function tick() {
    const now = Date.now()
    const dt = Math.min(now - lastTick, 5000) // 休眠/卡顿后不补算
    lastTick = now
    const gen = trackMessages()
    const active = document.visibilityState === 'visible' && document.hasFocus() &&
      (gen || now - lastInput < IDLE_MS)
    if (active) addPending(dt, 0)
  }

  async function loadStored() {
    if (!alive()) return
    try {
      const got = await chrome.storage.local.get(null)
      stored = {}
      for (const [k, v] of Object.entries(got)) if (k.startsWith('u:')) stored[k.slice(2)] = v
    } catch { /* 扩展已重载 */ }
  }

  // 已存的 + 本页尚未写入的
  function statsFor(day, which) {
    const s = (stored[day] && stored[day][which]) || { ms: 0, tok: 0 }
    if (which === SITE && pending.day === day) return { ms: s.ms + pending.ms, tok: s.tok + pending.tok }
    return { ms: s.ms, tok: s.tok }
  }

  // 统计区间：周从周一算起
  const PERIODS = [
    { id: 'day', label: '今日' },
    { id: 'week', label: '本周' },
    { id: 'month', label: '本月' },
    { id: 'year', label: '今年' },
    { id: 'all', label: '累计' },
  ]

  function periodStart(id) {
    const d = new Date()
    if (id === 'day') return dayKey()
    if (id === 'week') return dayKey(d.getTime() - ((d.getDay() + 6) % 7) * 864e5)
    if (id === 'month') return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-01`
    if (id === 'year') return `${d.getFullYear()}-01-01`
    return ''
  }

  function sumPeriod(which, id) {
    const from = periodStart(id)
    let ms = 0, tok = 0
    const days = new Set(Object.keys(stored))
    if (which === SITE) days.add(pending.day)
    for (const day of days) {
      if (day < from) continue
      const s = statsFor(day, which)
      ms += s.ms; tok += s.tok
    }
    return { ms, tok }
  }

  // 用量行显示哪个区间：点一下切换，记在本页
  let period = 'day'
  try { if (PERIODS.some(p => p.id === localStorage.getItem('cq-period'))) period = localStorage.getItem('cq-period') } catch { /* 无痕等 */ }

  function fmtTime(ms) {
    const m = Math.floor(ms / 60000)
    if (m < 60) return `${m}m`
    const h = Math.floor(m / 60)
    if (h >= 100) return `${h}h`
    return `${h}h${pad(m % 60)}m`
  }

  function fmtTok(n) {
    if (n < 1000) return String(n)
    if (n < 1e6) return `${(n / 1000).toFixed(n < 1e4 ? 1 : 0)}k`
    return `${(n / 1e6).toFixed(1)}M`
  }

  // ======================================================================
  // 定位头像行
  // ======================================================================
  function findAccountButton() {
    const direct = site.accountButton()
    if (direct && direct.offsetWidth > 0) return direct
    const nav = document.querySelector('nav') || document.querySelector('[class*="z-sidebar"]')
    if (!nav) return null
    const buttons = [...nav.querySelectorAll('button, a, [role="button"]')].filter(b => b.offsetWidth > 0)
    return buttons.reverse().find(b => site.plan.test(b.textContent || '')) || null
  }

  // ======================================================================
  // 绘制
  // ======================================================================
  // 同心圆：外圈 5 小时（灰），内圈 7 天（红）；弧长 = 剩余量
  const SVG = 'http://www.w3.org/2000/svg'
  const RINGS = { five_hour: 8, seven_day: 4.5 }
  const CIRC = r => 2 * Math.PI * r

  function circle(cls, r) {
    const c = document.createElementNS(SVG, 'circle')
    c.setAttribute('class', cls)
    c.setAttribute('cx', '10')
    c.setAttribute('cy', '10')
    c.setAttribute('r', String(r))
    return c
  }

  function buildMeter() {
    const meter = el('div')
    meter.id = 'cq-meter'
    meter.setAttribute('role', 'status')

    const quota = el('div', 'cq-quota')
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('class', 'cq-rings')
    svg.setAttribute('width', '20')
    svg.setAttribute('height', '20')
    svg.setAttribute('viewBox', '0 0 20 20')
    const nums = el('div', 'cq-nums')
    for (const [kind, r] of Object.entries(RINGS)) {
      const track = circle('cq-track', r)
      const arc = circle('cq-arc', r)
      arc.dataset.kind = kind
      arc.setAttribute('stroke-dasharray', String(CIRC(r)))
      arc.setAttribute('stroke-dashoffset', String(CIRC(r)))
      svg.append(track, arc)
    }
    const n = el('span', 'cq-num') // 只显示 5 小时剩余；7 天只用内圈表示
    n.dataset.kind = 'five_hour'
    nums.appendChild(n)
    quota.append(svg, nums)
    quota.hidden = true

    meter.append(quota)
    meter.addEventListener('mouseenter', openCard)
    meter.addEventListener('mouseleave', closeCard)
    return meter
  }

  // 名字下方一行：今日 1h12m · 4.0k tokens；点一下切换 本周/本月/今年/累计
  function buildLine() {
    const line = el('div')
    line.id = 'cq-line'
    line.setAttribute('role', 'button')
    line.title = '点击切换：今日 / 本周 / 本月 / 今年 / 累计'
    line.addEventListener('click', ev => {
      ev.stopPropagation()
      const i = PERIODS.findIndex(p => p.id === period)
      period = PERIODS[(i + 1) % PERIODS.length].id
      try { localStorage.setItem('cq-period', period) } catch { /* 无痕等 */ }
      render()
    })
    line.append(el('span', 'cq-label'), el('span', 'cq-time'), el('span', 'cq-dot', '·'), el('span', 'cq-tok'))
    line.addEventListener('mouseenter', openCard)
    line.addEventListener('mouseleave', closeCard)
    return line
  }

  function card() {
    let c = document.getElementById('cq-card')
    if (!c) {
      c = el('div')
      c.id = 'cq-card'
      document.body.appendChild(c)
    }
    return c
  }

  const both = id => {
    const a = sumPeriod('claude', id), b = sumPeriod('chatgpt', id)
    return { claude: a, chatgpt: b, total: { ms: a.ms + b.ms, tok: a.tok + b.tok } }
  }

  // 当前区间：Claude / ChatGPT / 合计；下面是各区间的合计
  function statsTable() {
    const label = PERIODS.find(p => p.id === period).label
    const cur = both(period)
    const t = el('div', 'cq-table')
    const head = el('div', 'cq-tr cq-th')
    head.append(el('span', null, label), el('span', null, '时长'), el('span', null, 'Token'))
    t.appendChild(head)
    for (const w of ['claude', 'chatgpt', 'total']) {
      const tr = el('div', `cq-tr${w === 'total' ? ' cq-total' : ''}${w === SITE ? ' cq-here' : ''}`)
      tr.append(el('span', null, SITE_NAME[w] || '合计'), el('span', null, fmtTime(cur[w].ms)), el('span', null, fmtTok(cur[w].tok)))
      t.appendChild(tr)
    }
    const sub = el('div', 'cq-tr cq-th cq-gap')
    sub.append(el('span', null, '两者合计'), el('span'), el('span'))
    t.appendChild(sub)
    for (const p of PERIODS) {
      if (p.id === period) continue
      const s = both(p.id).total
      const tr = el('div', 'cq-tr cq-week')
      tr.append(el('span', null, p.label), el('span', null, fmtTime(s.ms)), el('span', null, fmtTok(s.tok)))
      t.appendChild(tr)
    }
    return t
  }

  function fillCard() {
    const c = card()
    c.replaceChildren()
    for (const w of windows()) {
      const block = el('div', 'cq-block')
      const row = el('div', 'cq-row')
      const l = el('div')
      l.append(el('div', 'cq-label', LABELS[w.kind]), el('div', 'cq-sub', untilReset(w.resetsAt)))
      row.append(l, el('div', 'cq-value', `剩 ${left(w.used)}%`))
      const bar = el('div', 'cq-bar')
      const fill = el('i')
      fill.dataset.kind = w.kind
      fill.style.width = `${left(w.used)}%`
      bar.appendChild(fill)
      block.append(row, bar)
      c.appendChild(block)
    }
    if (windows().length) {
      const mins = Math.round((Date.now() - fetchedAt) / 60000)
      c.appendChild(el('div', 'cq-foot', mins < 1 ? '额度刚刚更新' : `额度 ${mins} 分钟前更新`))
      c.appendChild(el('div', 'cq-sep'))
    }
    c.appendChild(statsTable())
    c.appendChild(el('div', 'cq-foot', '点下方用量行切换区间。时长：页面在前台且 3 分钟内有操作才计。Token：按对话文字估算，不含系统提示和每轮重复发送的上下文。'))
  }

  function openCard(ev) {
    fillCard()
    const c = card()
    const r = ev.currentTarget.getBoundingClientRect()
    c.style.left = `${Math.max(8, r.left - 8)}px`
    // 上方放不下（头像行在侧栏顶部时）就往下展开
    c.style.top = c.style.bottom = ''
    c.setAttribute('data-open', '')
    if (r.top - c.offsetHeight - 10 < 8) c.style.top = `${r.bottom + 10}px`
    else c.style.bottom = `${window.innerHeight - r.top + 10}px`
  }

  function closeCard() {
    document.getElementById('cq-card')?.removeAttribute('data-open')
  }

  // ======================================================================
  // 摆放
  // ======================================================================
  // 头像行里文字（名字、套餐）在屏幕上占的范围
  function textBox(button) {
    const box = { left: Infinity, right: 0, bottom: 0 }
    const range = document.createRange()
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue
      // 跳过头像里的字母（小方块/圆形元素里的文字）
      const p = n.parentElement && n.parentElement.getBoundingClientRect()
      if (p && p.width <= 48 && Math.abs(p.width - p.height) < 4) continue
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) {
        if (!r.width) continue
        box.left = Math.min(box.left, r.left)
        box.right = Math.max(box.right, r.right)
        box.bottom = Math.max(box.bottom, r.bottom)
      }
    }
    return box
  }

  // 头像行里实际内容（名字、套餐、箭头）在屏幕上的右边界
  function contentRight(button) {
    let right = textBox(button).right
    for (const e of button.querySelectorAll('svg, img')) {
      const r = e.getBoundingClientRect()
      if (r.width > 0) right = Math.max(right, r.right)
    }
    return right
  }

  // 「Pro」「Plus」这类次要文字：数字沿用它的字号和字体，和这一行融为一体
  function quietText(button) {
    return [...button.querySelectorAll('span, div, p')]
      .find(e => e.children.length === 0 && site.plan.test(e.textContent || '')) || null
  }

  // 右侧可用到哪里：同一行右边第一个可见元素（如设置图标）的左边，留 8px
  function rightLimit(button, from) {
    const row = button.parentElement
    let limit = Math.max(button.getBoundingClientRect().right, row ? row.getBoundingClientRect().right : 0) - 8
    for (const e of row ? row.querySelectorAll('button, a, svg, img, [role="button"]') : []) {
      if (button.contains(e) || e.closest('#cq-meter')) continue
      const r = e.getBoundingClientRect()
      if (r.width > 0 && r.left >= from) limit = Math.min(limit, r.left - 8)
    }
    return limit
  }

  // 浮在头像行上、贴着名字右侧；不插进页面布局，所以不会被挤到下一行
  function place() {
    const meter = document.getElementById('cq-meter')
    const line = document.getElementById('cq-line')
    const button = findAccountButton()
    if (!meter || !line || !button) return
    const b = button.getBoundingClientRect()
    if (b.width < 120 || b.height === 0) { meter.hidden = line.hidden = true; return }
    placeLine(line, button)
    meter.hidden = meter.querySelector('.cq-quota').hidden
    if (meter.hidden) return

    const quiet = quietText(button)
    if (quiet) {
      const cs = getComputedStyle(quiet)
      meter.style.fontSize = cs.fontSize
      meter.style.fontFamily = cs.fontFamily
    }

    const x = contentRight(button) + 10
    const limit = rightLimit(button, x)
    // 放不下百分比时只留圆环（额度和用量分开两行，不混在一起）
    delete meter.dataset.compact
    if (x + meter.offsetWidth > limit) meter.dataset.compact = ''
    if (x + meter.offsetWidth > limit) { meter.hidden = true; return }

    meter.style.left = `${Math.round(x)}px`
    meter.style.top = `${Math.round(b.top + b.height / 2 - meter.offsetHeight / 2)}px`
  }

  // 用量行：左边和名字对齐，紧贴名字（或套餐）文字的下方
  function placeLine(line, button) {
    const t = textBox(button)
    if (!isFinite(t.left)) { line.hidden = true; return }
    line.hidden = false
    line.style.left = `${Math.round(t.left)}px`
    line.style.top = `${Math.round(t.bottom + 1)}px`
  }

  let observed = null
  const resize = new ResizeObserver(() => place())

  function render() {
    const button = findAccountButton()
    if (!button) return

    let meter = document.getElementById('cq-meter')
    if (!meter) {
      meter = buildMeter()
      document.body.appendChild(meter)
    }
    let line = document.getElementById('cq-line')
    if (!line) {
      line = buildLine()
      document.body.appendChild(line)
    }
    if (observed !== button) {
      resize.disconnect()
      resize.observe(button)
      if (button.parentElement) resize.observe(button.parentElement)
      observed = button
    }

    const list = windows()
    meter.querySelector('.cq-quota').hidden = list.length === 0
    for (const [kind, r] of Object.entries(RINGS)) {
      const w = list.find(x => x.kind === kind)
      const pct = w ? left(w.used) : 0
      meter.querySelector(`.cq-arc[data-kind="${kind}"]`)
        .setAttribute('stroke-dashoffset', String(CIRC(r) * (1 - pct / 100)))
    }
    const five = list.find(x => x.kind === 'five_hour')
    const num = meter.querySelector('.cq-num')
    num.hidden = !five
    num.textContent = five ? `${left(five.used)}%` : ''

    const label = PERIODS.find(p => p.id === period).label
    const mine = sumPeriod(SITE, period)
    line.querySelector('.cq-label').textContent = label
    line.querySelector('.cq-time').textContent = fmtTime(mine.ms)
    line.querySelector('.cq-tok').textContent = `${fmtTok(mine.tok)} tokens`
    line.setAttribute('aria-label', `${label} ${SITE_NAME[SITE]} 使用 ${fmtTime(mine.ms)}，约 ${fmtTok(mine.tok)} token，点击切换区间`)

    const parts = list.map(w => `${LABELS[w.kind]}剩 ${left(w.used)}%`)
    meter.setAttribute('aria-label', parts.join('，'))
    place()
    if (document.getElementById('cq-card')?.hasAttribute('data-open')) fillCard()
  }

  // ======================================================================
  // 事件
  // ======================================================================
  // React 重绘侧栏、侧栏展开收起时，重新找头像行并对齐
  let scheduled = false
  new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      if (observed !== findAccountButton()) render()
      else place()
    })
  }).observe(document.body, { childList: true, subtree: true })

  const touch = () => { lastInput = Date.now() }
  for (const t of ['pointerdown', 'keydown', 'wheel', 'mousemove', 'touchstart']) {
    window.addEventListener(t, touch, { capture: true, passive: true })
  }

  window.addEventListener('resize', place)
  document.addEventListener('scroll', place, true)
  document.addEventListener('transitionend', place, true)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { flush(); return }
    lastTick = Date.now()
    if (Date.now() - fetchedAt > 30000) refreshQuota()
    loadStored().then(render)
  })
  window.addEventListener('pagehide', flush)
  window.addEventListener('focus', () => { lastTick = Date.now() })

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local') return
      let hit = false
      for (const [k, { newValue }] of Object.entries(changes)) {
        if (!k.startsWith('u:')) continue
        stored[k.slice(2)] = newValue
        hit = true
      }
      if (hit) render()
    })
  } catch { /* 非扩展环境 */ }

  setInterval(tick, TICK_MS)
  setInterval(flush, FLUSH_MS)
  setInterval(() => { if (!document.hidden) render() }, 30000) // 让分钟数走起来
  setInterval(() => { if (!document.hidden) refreshQuota() }, QUOTA_MS)
  loadStored().then(render)
  refreshQuota()
})()

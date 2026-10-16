// Claude 额度环：在左下角头像行显示额度剩余。只请求 claude.ai 自己的接口，数据不出本机。
(() => {
  const REFRESH_MS = 2 * 60 * 1000
  const PLAN = /(Free|Pro|Max|Team|Enterprise)\b/
  const LABELS = { five_hour: '5 小时额度', seven_day: '7 天额度' }

  let usage = null
  let fetchedAt = 0
  let orgId = null

  // ---------- 数据 ----------
  async function getJson(path) {
    const r = await fetch(path, { credentials: 'include' })
    if (!r.ok) throw new Error(String(r.status))
    return r.json()
  }

  async function refresh() {
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

  // ---------- 定位头像行 ----------
  function findAccountButton() {
    const byTestId = document.querySelector('[data-testid="user-menu-button"]')
    if (byTestId) return byTestId
    const nav = document.querySelector('nav') || document.querySelector('[class*="z-sidebar"]')
    if (!nav) return null
    const buttons = [...nav.querySelectorAll('button')].filter(b => b.offsetWidth > 0)
    return buttons.reverse().find(b => PLAN.test(b.textContent || '')) || null
  }

  // ---------- 绘制 ----------
  // 同心圆：外圈 5 小时（灰），内圈 7 天（红）；弧长 = 剩余量
  const SVG = 'http://www.w3.org/2000/svg'
  const RINGS = { five_hour: 8, seven_day: 4.5 }
  const CIRC = r => 2 * Math.PI * r

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }

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
    meter.append(svg, nums)
    meter.addEventListener('mouseenter', openCard)
    meter.addEventListener('mouseleave', closeCard)
    return meter
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
    const mins = Math.round((Date.now() - fetchedAt) / 60000)
    c.appendChild(el('div', 'cq-foot', mins < 1 ? '刚刚更新' : `${mins} 分钟前更新`))
  }

  function openCard(ev) {
    if (!usage) return
    fillCard()
    const c = card()
    const r = ev.currentTarget.getBoundingClientRect()
    c.style.left = `${Math.max(8, r.left - 8)}px`
    c.style.bottom = `${window.innerHeight - r.top + 10}px`
    c.setAttribute('data-open', '')
  }

  function closeCard() {
    document.getElementById('cq-card')?.removeAttribute('data-open')
  }

  // ---------- 摆放 ----------
  // 头像行里实际内容（名字、套餐、箭头）在屏幕上的右边界
  function contentRight(button) {
    let right = 0
    const range = document.createRange()
    const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT)
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if (!n.textContent.trim()) continue
      range.selectNodeContents(n)
      for (const r of range.getClientRects()) right = Math.max(right, r.right)
    }
    for (const e of button.querySelectorAll('svg, img')) {
      const r = e.getBoundingClientRect()
      if (r.width > 0) right = Math.max(right, r.right)
    }
    return right
  }

  // 「Pro」这类次要文字：百分比沿用它的字号和字体，和这一行融为一体
  function quietText(button) {
    return [...button.querySelectorAll('span, div, p')]
      .find(e => e.children.length === 0 && PLAN.test(e.textContent || '')) || null
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
    const button = findAccountButton()
    if (!meter || !button || !windows().length) return
    const b = button.getBoundingClientRect()
    if (b.width < 120 || b.height === 0) { meter.hidden = true; return }
    meter.hidden = false

    const quiet = quietText(button)
    if (quiet) {
      const cs = getComputedStyle(quiet)
      meter.style.fontSize = cs.fontSize
      meter.style.fontFamily = cs.fontFamily
    }

    const x = contentRight(button) + 10
    const limit = rightLimit(button, x)
    meter.removeAttribute('data-compact')
    if (x + meter.offsetWidth > limit) meter.setAttribute('data-compact', '')
    if (x + meter.offsetWidth > limit) { meter.hidden = true; return }

    meter.style.left = `${Math.round(x)}px`
    meter.style.top = `${Math.round(b.top + b.height / 2 - meter.offsetHeight / 2)}px`
  }

  let observed = null
  const resize = new ResizeObserver(() => place())

  function render() {
    const list = windows()
    if (list.length === 0) return
    const button = findAccountButton()
    if (!button) return

    let meter = document.getElementById('cq-meter')
    if (!meter) {
      meter = buildMeter()
      document.body.appendChild(meter)
    }
    if (observed !== button) {
      resize.disconnect()
      resize.observe(button)
      if (button.parentElement) resize.observe(button.parentElement)
      observed = button
    }

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
    meter.setAttribute('aria-label', list.map(w => `${LABELS[w.kind]}剩 ${left(w.used)}%`).join('，'))
    place()
    if (document.getElementById('cq-card')?.hasAttribute('data-open')) fillCard()
  }

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

  window.addEventListener('resize', place)
  document.addEventListener('scroll', place, true)
  document.addEventListener('transitionend', place, true)
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - fetchedAt > 30000) refresh()
  })
  setInterval(() => { if (!document.hidden) refresh() }, REFRESH_MS)
  refresh()
})()

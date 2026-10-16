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
  const SVG = 'http://www.w3.org/2000/svg'
  const R = 7
  const C = 2 * Math.PI * R

  function el(tag, cls, text) {
    const e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = text
    return e
  }

  function buildRing() {
    const ring = el('span')
    ring.id = 'cq-ring'
    ring.setAttribute('role', 'status')
    const svg = document.createElementNS(SVG, 'svg')
    svg.setAttribute('width', '18')
    svg.setAttribute('height', '18')
    svg.setAttribute('viewBox', '0 0 18 18')
    for (const cls of ['cq-track', 'cq-arc']) {
      const c = document.createElementNS(SVG, 'circle')
      c.setAttribute('class', cls)
      c.setAttribute('cx', '9')
      c.setAttribute('cy', '9')
      c.setAttribute('r', String(R))
      c.setAttribute('fill', 'none')
      c.setAttribute('stroke-width', '2')
      c.setAttribute('stroke-linecap', 'round')
      if (cls === 'cq-arc') c.setAttribute('stroke-dasharray', String(C))
      svg.appendChild(c)
    }
    ring.append(svg, el('span', 'cq-num'))
    ring.addEventListener('mouseenter', openCard)
    ring.addEventListener('mouseleave', closeCard)
    return ring
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
      const row = el('div', 'cq-row')
      const l = el('div')
      l.append(el('div', 'cq-label', LABELS[w.kind]), el('div', 'cq-sub', untilReset(w.resetsAt)))
      row.append(l, el('div', 'cq-value', `剩 ${left(w.used)}%`))
      const bar = el('div', 'cq-bar')
      const fill = el('i')
      fill.style.width = `${left(w.used)}%`
      bar.appendChild(fill)
      const block = el('div', 'cq-row')
      block.style.display = 'block'
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
    c.style.left = `${Math.max(8, r.left)}px`
    c.style.bottom = `${window.innerHeight - r.top + 8}px`
    c.setAttribute('data-open', '')
  }

  function closeCard() {
    document.getElementById('cq-card')?.removeAttribute('data-open')
  }

  function render() {
    const list = windows()
    if (list.length === 0) return
    const button = findAccountButton()
    if (!button) return

    let ring = document.getElementById('cq-ring')
    if (!ring) ring = buildRing()
    if (ring.previousElementSibling !== button) button.after(ring)

    // 主显示取最紧的窗口
    const tight = list.reduce((a, b) => (b.used > a.used ? b : a))
    const pct = left(tight.used)
    ring.querySelector('.cq-arc').setAttribute('stroke-dashoffset', String(C * (1 - pct / 100)))
    ring.querySelector('.cq-num').textContent = `${pct}%`
    ring.dataset.level = pct <= 10 ? 'low' : 'ok'
    ring.toggleAttribute('data-compact', button.offsetWidth < 80)
    ring.setAttribute('aria-label', list.map(w => `${LABELS[w.kind]}剩 ${left(w.used)}%`).join('，'))
    if (document.getElementById('cq-card')?.hasAttribute('data-open')) fillCard()
  }

  // React 重绘侧栏时会移走注入的节点，这里补回
  let scheduled = false
  new MutationObserver(() => {
    if (scheduled) return
    scheduled = true
    requestAnimationFrame(() => {
      scheduled = false
      const ring = document.getElementById('cq-ring')
      if (!ring || !ring.isConnected || ring.previousElementSibling !== findAccountButton()) render()
    })
  }).observe(document.body, { childList: true, subtree: true })

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() - fetchedAt > 30000) refresh()
  })
  setInterval(() => { if (!document.hidden) refresh() }, REFRESH_MS)
  refresh()
})()

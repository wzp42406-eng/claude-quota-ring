// 用量统计的唯一写入方：各页面把增量发过来，这里串行累加，避免多个标签页同时写丢数据。
// 存储结构：chrome.storage.local 键 `u:YYYY-MM-DD` → { claude: { ms, tok }, chatgpt: { ms, tok } }
// 按天永久保存（每天约 100 字节），周/月/年/累计都由这些按天记录相加得到。
// 另外把全部记录同步给本机的用量 API（usage-api/server.py），没运行就静默跳过。
const API = 'http://127.0.0.1:8787/api/sync'
const SYNC_DELAY_MS = 5000

let queue = Promise.resolve()

function add({ day, site, ms = 0, tok = 0 }) {
  queue = queue.then(async () => {
    const key = `u:${day}`
    const { [key]: rec = {} } = await chrome.storage.local.get(key)
    const s = rec[site] || { ms: 0, tok: 0 }
    rec[site] = { ms: s.ms + Math.max(0, ms), tok: s.tok + Math.max(0, tok) }
    await chrome.storage.local.set({ [key]: rec })
  }).catch(() => {})
  return queue
}

let syncTimer = null

function scheduleSync() {
  clearTimeout(syncTimer)
  syncTimer = setTimeout(sync, SYNC_DELAY_MS)
}

async function sync() {
  try {
    const all = await chrome.storage.local.get(null)
    const days = {}
    for (const [k, v] of Object.entries(all)) if (k.startsWith('u:')) days[k.slice(2)] = v
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days }),
    })
  } catch {
    /* 本机 API 没开：下次再试 */
  }
}

// claude.ai 的 5 小时 / 7 天额度：直接报给本机 API
async function sendQuota(limits) {
  try {
    await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ days: {}, quota: limits }),
    })
  } catch { /* 本机 API 没开 */ }
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'getQuota') {
    fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ days: {} }) })
      .then(r => r.json()).then(d => reply(d.quota || null)).catch(() => reply(null))
    return true
  }
  if (msg && msg.type === 'quota' && Array.isArray(msg.limits)) {
    sendQuota(msg.limits).then(() => reply(true))
    return true
  }
  if (msg && msg.type === 'usage' && (msg.site === 'claude' || msg.site === 'chatgpt')) {
    add(msg).then(() => { scheduleSync(); reply(true) })
    return true
  }
})

chrome.runtime.onInstalled.addListener(sync)
chrome.runtime.onStartup.addListener(sync)

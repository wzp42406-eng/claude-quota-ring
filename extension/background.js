// 用量统计的唯一写入方：各页面把增量发过来，这里串行累加，避免多个标签页同时写丢数据。
// 存储结构：chrome.storage.local 键 `u:YYYY-MM-DD` → { claude: { ms, tok }, chatgpt: { ms, tok } }
const KEEP_DAYS = 90

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

async function prune() {
  const all = await chrome.storage.local.get(null)
  const d = new Date(Date.now() - KEEP_DAYS * 864e5)
  const cutoff = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const old = Object.keys(all).filter(k => k.startsWith('u:') && k.slice(2) < cutoff)
  if (old.length) await chrome.storage.local.remove(old)
}

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  if (msg && msg.type === 'usage' && (msg.site === 'claude' || msg.site === 'chatgpt')) {
    add(msg).then(() => reply(true))
    return true
  }
})

chrome.runtime.onInstalled.addListener(prune)
chrome.runtime.onStartup.addListener(prune)

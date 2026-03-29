/*
  Live Monad testnet feed laid out entirely in JS via Pretext.
  - WSS connection to the Monad testnet RPC for real-time blocks.
  - Every transaction formatted as prose, flowing through multi-column editorial layout.
  - layoutNextLine() drives per-line placement with cursor resumption across columns.
  - No DOM text measurement anywhere — all heights and widths from Pretext.
*/
import {
  layoutNextLine,
  prepareWithSegments,
  type LayoutCursor,
  type PreparedTextWithSegments,
} from '../../src/layout.ts'
import monadLogoUrl from '../assets/monad-symbol.svg'

// ── Constants ──────────────────────────────────────────────────────────

const WSS_URL = 'wss://rpc-mainnet.monadinfra.com'
const BODY_FONT = '17px "Iowan Old Style", "Palatino Linotype", "Book Antiqua", Palatino, serif'
const BODY_LINE_HEIGHT = 25
const MAX_BLOCKS = 30
const MAX_TXS_PER_BLOCK = 40
const RECONNECT_DELAY = 3000
const POLL_INTERVAL = 2000

// ── Types ──────────────────────────────────────────────────────────────

type RpcBlock = {
  number: string
  timestamp: string
  gasUsed: string
  hash: string
  transactions: RpcTransaction[]
}

type RpcTransaction = {
  hash: string
  from: string
  to: string | null
  value: string
  gas: string
  input: string
}

type PositionedLine = {
  x: number
  y: number
  text: string
}

type Interval = {
  left: number
  right: number
}

// Inner diamond vertices in SVG coords (viewBox 90 90 300 300)
// Converted to normalized [0,1] relative to logo display size
const DIAMOND_SVG = [
  { x: 154.285, y: 216.624 }, // left
  { x: 263.533, y: 154.226 }, // top
  { x: 325.989, y: 263.376 }, // right
  { x: 216.739, y: 325.774 }, // bottom
]
const DIAMOND_NORM = DIAMOND_SVG.map(p => ({ x: (p.x - 90) / 300, y: (p.y - 90) / 300 }))

// Get the horizontal extent [left, right] of the diamond polygon at a given y (normalized)
function diamondIntervalAtY(y: number): { left: number, right: number } | null {
  const pts = DIAMOND_NORM
  const n = pts.length
  let minX = Infinity
  let maxX = -Infinity
  let hits = 0

  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    const yMin = Math.min(a.y, b.y)
    const yMax = Math.max(a.y, b.y)
    if (y < yMin || y > yMax || yMin === yMax) continue
    const t = (y - a.y) / (b.y - a.y)
    const x = a.x + t * (b.x - a.x)
    if (x < minX) minX = x
    if (x > maxX) maxX = x
    hits++
  }

  if (hits < 2) return null
  return { left: minX, right: maxX }
}

type LogoObstacle = {
  cx: number
  cy: number
  outerR: number
  logoX: number
  logoY: number
  logoSize: number
}

// ── Logo ───────────────────────────────────────────────────────────────

function resolveAssetUrl(url: string): string {
  if (/^(?:[a-z]+:)?\/\//i.test(url) || url.startsWith('data:') || url.startsWith('blob:')) return url
  if (url.startsWith('/')) return new URL(url, window.location.origin).href
  return new URL(url, import.meta.url).href
}

const MONAD_LOGO_SRC = resolveAssetUrl(monadLogoUrl)

type LogoState = { x: number, y: number, size: number }

function getLogoSize(w: number, h: number): number {
  return Math.min(Math.round(Math.min(w, h) * 0.34), 300)
}

function computeLogoRect(w: number, h: number, margin: number): LogoState {
  const size = getLogoSize(w, h)
  const pad = margin

  if (!logoInitialized) {
    logoInitialized = true
    logoCurrent = { x: w / 2 - size / 2, y: h / 2 - size / 2 }
    initLogoVelocity()
  }

  logoCurrent.x += logoVelocity.x
  logoCurrent.y += logoVelocity.y

  if (logoCurrent.x < pad) { logoCurrent.x = pad; logoVelocity.x = Math.abs(logoVelocity.x) }
  else if (logoCurrent.x + size > w - pad) { logoCurrent.x = w - pad - size; logoVelocity.x = -Math.abs(logoVelocity.x) }
  if (logoCurrent.y < pad) { logoCurrent.y = pad; logoVelocity.y = Math.abs(logoVelocity.y) }
  else if (logoCurrent.y + size > h - pad) { logoCurrent.y = h - pad - size; logoVelocity.y = -Math.abs(logoVelocity.y) }

  return { x: logoCurrent.x, y: logoCurrent.y, size }
}

// ── State ──────────────────────────────────────────────────────────────

let stage!: HTMLDivElement
let logoEl!: HTMLImageElement
let loadingEl!: HTMLDivElement
let dataReady = false

// Logo wander state — slow constant drift
let logoCurrent: { x: number, y: number } = { x: 0, y: 0 }
let logoVelocity: { x: number, y: number } = { x: 0, y: 0 }
let logoInitialized = false
const LOGO_SPEED = 0.4 // pixels per frame (~24px/s at 60fps)

function initLogoVelocity(): void {
  const angle = Math.random() * Math.PI * 2
  logoVelocity = { x: Math.cos(angle) * LOGO_SPEED, y: Math.sin(angle) * LOGO_SPEED }
}

let blocks: RpcBlock[] = []
let bodyText = ''
let preparedBody: PreparedTextWithSegments | null = null
let needsReprepare = true
let connectionState: 'connecting' | 'live' | 'polling' | 'mock' = 'connecting'
const linePool: HTMLDivElement[] = []
let rpcId = 0
const pendingCalls = new Map<number, (result: unknown) => void>()
let ws: WebSocket | null = null
let lastBlockNumber = 0
let pollTimer: ReturnType<typeof setInterval> | null = null

// Extra chain metadata
let chainId = ''
let gasPrice = ''
let peerCount = ''
let latestBaseFee = ''
let syncStatus = ''
let pendingTxCount = ''
let accountBalanceSamples: { addr: string, bal: string }[] = []

// ── WSS Connection ─────────────────────────────────────────────────────

function connect(): void {
  connectionState = 'connecting'
  try {
    ws = new WebSocket(WSS_URL)
  } catch {
    startPolling()
    return
  }

  const connectTimeout = setTimeout(() => {
    if (connectionState === 'connecting') {
      ws?.close()
      startPolling()
    }
  }, 6000)

  ws.onopen = () => {
    clearTimeout(connectTimeout)
    rpcCall('eth_subscribe', ['newHeads']).then((result) => {
      void result
      connectionState = 'live'
    }).catch(() => {
      startPolling()
    })
    // Also try subscribing to pending txs and logs for more data
    rpcCall('eth_subscribe', ['newPendingTransactions']).catch(() => {})
    rpcCall('eth_subscribe', ['logs', { topics: [] }]).catch(() => {})
    fetchLatestBlocks()
    fetchChainMeta()
    // Refresh chain metadata every 10s
    setInterval(() => fetchChainMeta(), 10000)
  }

  ws.onmessage = (event: MessageEvent) => {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(event.data as string) as Record<string, unknown>
    } catch {
      return
    }

    if (typeof msg['id'] === 'number' && pendingCalls.has(msg['id'])) {
      const resolve = pendingCalls.get(msg['id'])!
      pendingCalls.delete(msg['id'])
      resolve(msg['result'])
      return
    }

    if (msg['method'] === 'eth_subscription') {
      const params = msg['params'] as { result: Record<string, string> }
      onNewHead(params.result)
    }
  }

  ws.onclose = () => {
    clearTimeout(connectTimeout)
    // subscription lost
    if (connectionState === 'live') {
      setTimeout(connect, RECONNECT_DELAY)
    }
  }

  ws.onerror = () => {
    clearTimeout(connectTimeout)
    ws?.close()
  }
}

function startPolling(): void {
  if (pollTimer !== null) return
  connectionState = 'polling'

  fetchLatestBlocks()

  pollTimer = setInterval(async () => {
    try {
      const numHex = await httpRpc('eth_blockNumber', [])
      const num = parseInt(numHex as string, 16)
      if (num > lastBlockNumber) {
        const count = Math.min(num - lastBlockNumber, 3)
        for (let i = 0; i < count; i++) {
          const blockNum = num - count + 1 + i
          const block = await httpRpc('eth_getBlockByNumber', ['0x' + blockNum.toString(16), true])
          if (block) addBlock(block as RpcBlock)
        }
      }
    } catch {
      // polling failures are silent
    }
  }, POLL_INTERVAL)
}

async function httpRpc(method: string, params: unknown[]): Promise<unknown> {
  const httpUrl = WSS_URL.replace('wss://', 'https://').replace('ws://', 'http://')
  const response = await fetch(httpUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const json = await response.json() as { result: unknown }
  return json.result
}

function rpcCall(method: string, params: unknown[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      reject(new Error('not connected'))
      return
    }
    const id = ++rpcId
    pendingCalls.set(id, resolve)
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
    setTimeout(() => {
      if (pendingCalls.has(id)) {
        pendingCalls.delete(id)
        reject(new Error('timeout'))
      }
    }, 10000)
  })
}

async function fetchLatestBlocks(): Promise<void> {
  try {
    const rpc = ws && ws.readyState === WebSocket.OPEN
      ? (m: string, p: unknown[]) => rpcCall(m, p)
      : httpRpc

    const numHex = await rpc('eth_blockNumber', [])
    const latestNum = parseInt(numHex as string, 16)
    const fetchCount = Math.min(8, latestNum)

    for (let i = fetchCount - 1; i >= 0; i--) {
      const blockNum = latestNum - i
      const block = await rpc('eth_getBlockByNumber', ['0x' + blockNum.toString(16), true])
      if (block) addBlock(block as RpcBlock)
    }
  } catch {
    if (blocks.length === 0) {
      generateMockBlocks()
      connectionState = 'mock'
    }
  }
}

async function onNewHead(head: Record<string, string>): Promise<void> {
  try {
    const block = await rpcCall('eth_getBlockByNumber', [head['number'], true])
    if (block) addBlock(block as RpcBlock)
  } catch {
    // miss this block, next one will arrive
  }
}

async function fetchChainMeta(): Promise<void> {
  const rpc = ws && ws.readyState === WebSocket.OPEN
    ? (m: string, p: unknown[]) => rpcCall(m, p)
    : httpRpc

  try {
    const [cId, gp, pc, ptc] = await Promise.all([
      rpc('eth_chainId', []).catch(() => null),
      rpc('eth_gasPrice', []).catch(() => null),
      rpc('net_peerCount', []).catch(() => null),
      rpc('eth_getBlockTransactionCountByNumber', ['latest']).catch(() => null),
    ])

    if (cId) chainId = parseInt(cId as string, 16).toString()
    if (gp) {
      const gwei = Number(BigInt(gp as string)) / 1e9
      gasPrice = gwei < 1 ? gwei.toFixed(4) : gwei.toFixed(2)
    }
    if (pc) peerCount = parseInt(pc as string, 16).toString()
    if (ptc) pendingTxCount = parseInt(ptc as string, 16).toString()

    // Try to get base fee from latest block header
    if (blocks.length > 0) {
      const latest = blocks[0]!
      const baseFeeHex = (latest as Record<string, unknown>)['baseFeePerGas'] as string | undefined
      if (baseFeeHex) {
        const bf = Number(BigInt(baseFeeHex)) / 1e9
        latestBaseFee = bf < 1 ? bf.toFixed(4) : bf.toFixed(2)
      }
    }

    // Grab sync status
    const syncResult = await rpc('eth_syncing', []).catch(() => null)
    if (syncResult === false || syncResult === null) {
      syncStatus = 'synced'
    } else if (syncResult && typeof syncResult === 'object') {
      const s = syncResult as Record<string, string>
      const current = parseInt(s['currentBlock'] ?? '0', 16)
      const highest = parseInt(s['highestBlock'] ?? '0', 16)
      syncStatus = `syncing ${current.toLocaleString()}/${highest.toLocaleString()}`
    }

    // Sample a few "top of block" sender balances for flavor
    if (blocks.length > 0) {
      const senders = blocks[0]!.transactions.slice(0, 5).map(tx => tx.from)
      const balances = await Promise.all(
        senders.map(addr => rpc('eth_getBalance', [addr, 'latest']).catch(() => null))
      )
      accountBalanceSamples = senders.map((addr, i) => ({
        addr,
        bal: balances[i] ? formatWei(balances[i] as string) : '?',
      })).filter(s => s.bal !== '?' && s.bal !== '0')
    }
  } catch {
    // metadata is best-effort
  }

  rebuildText()
}

function addBlock(block: RpcBlock): void {
  const num = parseInt(block.number, 16)
  if (num <= lastBlockNumber && blocks.length > 0) return
  lastBlockNumber = Math.max(lastBlockNumber, num)

  blocks.unshift(block)
  if (blocks.length > MAX_BLOCKS) blocks.pop()
  rebuildText()
}

// ── Text Formatting ────────────────────────────────────────────────────

function truncAddr(addr: string): string {
  if (!addr || addr.length < 12) return addr
  return addr.slice(0, 8) + '\u2026' + addr.slice(-4)
}

function formatWei(hex: string): string {
  try {
    const wei = BigInt(hex)
    const eth = Number(wei) / 1e18
    if (eth === 0) return '0'
    if (eth < 0.001) return '<0.001'
    if (eth < 1) return eth.toFixed(3)
    if (eth < 1000) return eth.toFixed(2)
    return eth.toLocaleString('en', { maximumFractionDigits: 1 })
  } catch {
    return '0'
  }
}

function formatGas(hex: string): string {
  const gas = parseInt(hex, 16)
  if (isNaN(gas)) return '\u2014'
  if (gas >= 1_000_000) return (gas / 1_000_000).toFixed(1) + 'M'
  if (gas >= 1_000) return Math.round(gas / 1_000) + 'k'
  return gas.toLocaleString()
}

function formatTx(tx: RpcTransaction): string {
  const raw = tx as Record<string, unknown>
  const from = truncAddr(tx.from)
  const value = formatWei(tx.value)
  const gas = formatGas(tx.gas)
  const nonce = raw['nonce'] ? parseInt(raw['nonce'] as string, 16) : null
  const txHash = truncAddr(tx.hash)
  const gpHex = raw['gasPrice'] as string | undefined
  const gpStr = gpHex ? (Number(BigInt(gpHex)) / 1e9).toFixed(2) + ' gwei' : null

  const suffix = [
    gas + ' gas',
    gpStr,
    nonce !== null ? `nonce ${nonce}` : null,
    `tx ${txHash}`,
  ].filter(Boolean).join(', ')

  if (!tx.to) {
    const contractAddr = raw['creates'] as string | undefined
    const ca = contractAddr ? ` at ${truncAddr(contractAddr)}` : ''
    return `${from} deployed contract${ca}, ${suffix}`
  }

  const to = truncAddr(tx.to)
  const hasInput = tx.input !== undefined && tx.input !== '0x' && tx.input.length > 2

  if (hasInput) {
    const selector = tx.input.slice(0, 10)
    const dataLen = Math.floor((tx.input.length - 2) / 2)
    const dataNote = dataLen > 4 ? ` (${dataLen}B calldata)` : ''
    if (parseFloat(value) > 0) {
      return `${from} called ${selector} on ${to}${dataNote} with ${value} MON, ${suffix}`
    }
    return `${from} invoked ${selector} on ${to}${dataNote}, ${suffix}`
  }

  if (parseFloat(value) === 0) {
    return `${from} touched ${to}, ${suffix}`
  }

  return `${from} sent ${value} MON to ${to}, ${suffix}`
}

function formatBlock(block: RpcBlock): string {
  const num = parseInt(block.number, 16).toLocaleString()
  const txCount = block.transactions.length
  const gasUsed = formatGas(block.gasUsed)
  const blockHash = truncAddr(block.hash)
  const raw = block as Record<string, unknown>

  // Timestamp
  const ts = parseInt(block.timestamp, 16)
  const age = Math.max(0, Math.floor(Date.now() / 1000) - ts)
  const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.floor(age / 60)}m ago` : `${Math.floor(age / 3600)}h ago`

  // Extra header fields
  const miner = raw['miner'] as string | undefined
  const gasLimit = raw['gasLimit'] as string | undefined
  const baseFee = raw['baseFeePerGas'] as string | undefined
  const size = raw['size'] as string | undefined
  const parentHash = raw['parentHash'] as string | undefined

  let header = `Block ${num} (${blockHash}) \u00b7 ${ageStr} \u00b7 ${txCount} txns \u00b7 ${gasUsed} gas`
  if (gasLimit) header += `/${formatGas(gasLimit)} limit`
  if (baseFee) {
    const bf = Number(BigInt(baseFee)) / 1e9
    header += ` \u00b7 base ${bf < 1 ? bf.toFixed(4) : bf.toFixed(2)} gwei`
  }
  if (size) header += ` \u00b7 ${(parseInt(size, 16) / 1024).toFixed(1)}KB`
  if (miner) header += ` \u00b7 miner ${truncAddr(miner)}`
  if (parentHash) header += ` \u00b7 parent ${truncAddr(parentHash)}`
  header += ' \u2014 '

  const txs = block.transactions.slice(0, MAX_TXS_PER_BLOCK)
  let body = txs.map(formatTx).join('. ')

  if (block.transactions.length > MAX_TXS_PER_BLOCK) {
    body += `. Plus ${block.transactions.length - MAX_TXS_PER_BLOCK} more`
  }

  return header + body + '.'
}

function buildChainSummary(): string {
  const parts: string[] = []
  if (chainId) parts.push(`Chain ${chainId}`)
  if (gasPrice) parts.push(`gas price ${gasPrice} gwei`)
  if (latestBaseFee) parts.push(`base fee ${latestBaseFee} gwei`)
  if (peerCount) parts.push(`${peerCount} peers`)
  if (syncStatus) parts.push(syncStatus)
  if (pendingTxCount) parts.push(`${pendingTxCount} pending txns in latest block`)
  if (accountBalanceSamples.length > 0) {
    const samples = accountBalanceSamples.slice(0, 3)
      .map(s => `${truncAddr(s.addr)} holds ${s.bal} MON`)
      .join(', ')
    parts.push(samples)
  }
  if (parts.length === 0) return ''
  return `Monad mainnet \u2014 ${parts.join(' \u00b7 ')}.`
}

function rebuildText(): void {
  const chainSummary = buildChainSummary()
  const blockTexts = blocks.map(formatBlock).join(' ')
  bodyText = chainSummary ? `${chainSummary} ${blockTexts}` : blockTexts
  needsReprepare = true
  scheduleFrame()
}

// ── Layout (editorial-engine approach) ─────────────────────────────────

const GUTTER = 48
const COL_GAP = 40
const MIN_SLOT_WIDTH = 50

function logoRingIntervalsForBand(
  o: LogoObstacle, bandTop: number, bandBottom: number,
): Interval[] {
  // Outer circle chord
  if (bandTop >= o.cy + o.outerR || bandBottom <= o.cy - o.outerR) return []
  const outerMinDy = o.cy >= bandTop && o.cy <= bandBottom ? 0 : o.cy < bandTop ? bandTop - o.cy : o.cy - bandBottom
  if (outerMinDy >= o.outerR) return []
  const outerDx = Math.sqrt(o.outerR * o.outerR - outerMinDy * outerMinDy)
  const outerLeft = o.cx - outerDx
  const outerRight = o.cx + outerDx

  // Inner diamond at the band midpoint (normalized y)
  const bandMidY = ((bandTop + bandBottom) / 2 - o.logoY) / o.logoSize
  const inner = diamondIntervalAtY(bandMidY)

  if (!inner) {
    // Band outside the diamond — entire outer chord is blocked
    return [{ left: outerLeft, right: outerRight }]
  }

  // Convert normalized inner coords to page coords
  const innerLeft = o.logoX + inner.left * o.logoSize
  const innerRight = o.logoX + inner.right * o.logoSize

  // Two blocked arcs: left ring wall and right ring wall
  const result: Interval[] = []
  if (innerLeft - outerLeft > 2) result.push({ left: outerLeft, right: innerLeft })
  if (outerRight - innerRight > 2) result.push({ left: innerRight, right: outerRight })
  return result
}

function carveTextLineSlots(base: Interval, blocked: Interval[]): Interval[] {
  let slots = [base]
  for (let i = 0; i < blocked.length; i++) {
    const interval = blocked[i]!
    const next: Interval[] = []
    for (let j = 0; j < slots.length; j++) {
      const slot = slots[j]!
      if (interval.right <= slot.left || interval.left >= slot.right) {
        next.push(slot)
        continue
      }
      if (interval.left > slot.left) next.push({ left: slot.left, right: interval.left })
      if (interval.right < slot.right) next.push({ left: interval.right, right: slot.right })
    }
    slots = next
  }
  return slots.filter(slot => slot.right - slot.left >= MIN_SLOT_WIDTH)
}

function layoutColumn(
  prepared: PreparedTextWithSegments,
  startCursor: LayoutCursor,
  regionX: number, regionY: number, regionW: number, regionH: number,
  lineHeight: number,
  obstacles: LogoObstacle[],
): { lines: PositionedLine[], cursor: LayoutCursor } {
  let cursor = startCursor
  let lineTop = regionY
  const lines: PositionedLine[] = []
  let textExhausted = false

  while (lineTop + lineHeight <= regionY + regionH && !textExhausted) {
    const bandTop = lineTop
    const bandBottom = lineTop + lineHeight
    const blocked: Interval[] = []

    for (let i = 0; i < obstacles.length; i++) {
      const intervals = logoRingIntervalsForBand(obstacles[i]!, bandTop, bandBottom)
      for (let j = 0; j < intervals.length; j++) blocked.push(intervals[j]!)
    }

    const slots = carveTextLineSlots({ left: regionX, right: regionX + regionW }, blocked)
    if (slots.length === 0) {
      lineTop += lineHeight
      continue
    }

    // Fill ALL slots left-to-right (text flows on both sides of obstacle)
    const ordered = [...slots].sort((a, b) => a.left - b.left)
    for (let i = 0; i < ordered.length; i++) {
      const slot = ordered[i]!
      const line = layoutNextLine(prepared, cursor, slot.right - slot.left)
      if (line === null) { textExhausted = true; break }
      lines.push({ x: Math.round(slot.left), y: Math.round(lineTop), text: line.text })
      cursor = line.end
    }

    lineTop += lineHeight
  }

  return { lines, cursor }
}

// ── Rendering ──────────────────────────────────────────────────────────

function syncPool(pool: HTMLDivElement[], needed: number): void {
  while (pool.length < needed) {
    const el = document.createElement('div')
    stage.appendChild(el)
    pool.push(el)
  }
  for (let i = 0; i < pool.length; i++) {
    pool[i]!.style.display = i < needed ? '' : 'none'
  }
}

function renderBody(allLines: PositionedLine[]): void {
  syncPool(linePool, allLines.length)

  for (let i = 0; i < allLines.length; i++) {
    const el = linePool[i]!
    const p = allLines[i]!
    el.className = 'line'
    el.textContent = p.text
    el.style.left = `${p.x}px`
    el.style.top = `${p.y}px`
    el.style.font = BODY_FONT
    el.style.lineHeight = `${BODY_LINE_HEIGHT}px`
  }
}

// ── Mock Data ──────────────────────────────────────────────────────────

function randomHex(bytes: number): string {
  let hex = '0x'
  for (let i = 0; i < bytes; i++) {
    hex += Math.floor(Math.random() * 256).toString(16).padStart(2, '0')
  }
  return hex
}

function generateMockBlocks(): void {
  let blockNum = 4_521_337
  for (let i = 0; i < 12; i++) {
    const txCount = 30 + Math.floor(Math.random() * 120)
    const txs: RpcTransaction[] = []
    for (let j = 0; j < txCount; j++) {
      const isContractCall = Math.random() > 0.4
      const isDeployment = !isContractCall && Math.random() < 0.06
      txs.push({
        hash: randomHex(32),
        from: randomHex(20),
        to: isDeployment ? null : randomHex(20),
        value: '0x' + BigInt(Math.floor(Math.random() * 5e18)).toString(16),
        gas: '0x' + (21000 + Math.floor(Math.random() * 500000)).toString(16),
        input: isContractCall ? randomHex(36) : '0x',
      })
    }
    const block: RpcBlock = {
      number: '0x' + blockNum.toString(16),
      timestamp: '0x' + Math.floor(Date.now() / 1000 - i * 2).toString(16),
      gasUsed: '0x' + (8_000_000 + Math.floor(Math.random() * 22_000_000)).toString(16),
      hash: randomHex(32),
      transactions: txs,
    }
    blocks.push(block)
    lastBlockNumber = Math.max(lastBlockNumber, blockNum)
    blockNum--
  }
  rebuildText()
}

// ── Frame Loop ─────────────────────────────────────────────────────────

let frameScheduled = false

function scheduleFrame(): void {
  if (frameScheduled) return
  frameScheduled = true
  requestAnimationFrame(commitFrame)
}

function commitFrame(): void {
  frameScheduled = false

  const w = window.innerWidth
  const h = window.innerHeight

  // Always schedule next frame — logo is always drifting
  frameScheduled = true
  requestAnimationFrame(commitFrame)

  if (!bodyText) return

  if (!dataReady) {
    dataReady = true
    logoEl.style.display = ''
    loadingEl.classList.add('hidden')
    setTimeout(() => { loadingEl.style.display = 'none' }, 700)
  }

  if (needsReprepare) {
    preparedBody = prepareWithSegments(bodyText, BODY_FONT)
    needsReprepare = false
  }

  // Compute logo obstacle
  const logo = computeLogoRect(w, h, GUTTER)
  logoEl.style.left = `${Math.round(logo.x)}px`
  logoEl.style.top = `${Math.round(logo.y)}px`
  logoEl.style.width = `${logo.size}px`
  logoEl.style.height = `${logo.size}px`

  const obstacle: LogoObstacle = {
    cx: logo.x + logo.size / 2,
    cy: logo.y + logo.size / 2,
    outerR: logo.size / 2,
    logoX: logo.x,
    logoY: logo.y,
    logoSize: logo.size,
  }

  // Multi-column layout
  const columnCount = w > 1000 ? 3 : w > 640 ? 2 : 1
  const maxContentWidth = w - GUTTER * 2
  const totalGutter = (columnCount - 1) * COL_GAP
  const columnWidth = Math.floor((maxContentWidth - totalGutter) / columnCount)
  const contentLeft = Math.round((w - (columnCount * columnWidth + totalGutter)) / 2)
  const topMargin = 24
  const columnHeight = h - topMargin - 16

  if (!preparedBody || columnHeight <= 0) return

  const allLines: PositionedLine[] = []
  let cursor: LayoutCursor = { segmentIndex: 0, graphemeIndex: 0 }

  for (let i = 0; i < columnCount; i++) {
    const colX = contentLeft + i * (columnWidth + COL_GAP)
    const result = layoutColumn(
      preparedBody, cursor,
      colX, topMargin, columnWidth, columnHeight,
      BODY_LINE_HEIGHT, [obstacle],
    )
    allLines.push(...result.lines)
    cursor = result.cursor
  }

  renderBody(allLines)
}

// ── Init ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await document.fonts.ready

  stage = document.getElementById('stage') as HTMLDivElement
  logoEl = document.getElementById('monad-logo') as HTMLImageElement
  loadingEl = document.getElementById('loading') as HTMLDivElement
  logoEl.src = MONAD_LOGO_SRC
  logoEl.style.display = 'none'

  connect()

  // If nothing arrives within 5s, fall back to mock data
  setTimeout(() => {
    if (blocks.length === 0) {
      generateMockBlocks()
      connectionState = 'mock'
    }
  }, 5000)

  window.addEventListener('resize', scheduleFrame)
  scheduleFrame()
}

main()

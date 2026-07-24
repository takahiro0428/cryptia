<script setup lang="ts">
import { ASSET_MAP } from '~/shared/assets'
import { fmtPct } from '~/shared/format'
import type { FundFlow, Ticker } from '~/shared/types'

/**
 * 空間バブルマップ（UC-2 / F-02）。
 * - 銘柄を時価総額比例のバブルとして力学配置（反発 + 中心引力 + フロー相互の引き寄せ）
 * - 銘柄間の推定資金フローを矢印で描画（太さ = フロー量、粒子アニメーションで方向を表現)
 * - タップ/クリックでバブル選択 → 親に select イベント
 */
const props = defineProps<{
  tickers: Ticker[]
  flows: FundFlow[]
  selectedId: string | null
}>()
const emit = defineEmits<{ select: [assetId: string | null] }>()

interface Node {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  r: number
  color: string
  symbol: string
  changePct: number
}

const wrapRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
let nodes: Node[] = []
let raf = 0
let width = 0
let height = 0
let particlePhase = 0

function nodeRadius(t: Ticker, maxMcap: number, minDim: number): number {
  // べき 0.4 で時価総額の桁差を圧縮する（線形/平方根では BTC が支配的になり
  // 小型銘柄がラベル未満のサイズに潰れるため）
  const ratio = (Math.max(t.marketCapUsd, 1) / Math.max(maxMcap, 1)) ** 0.4
  return minDim * (0.038 + ratio * 0.085)
}

/** ティッカー更新時にノードを同期（既存ノードの位置は保持: 状態保護） */
function syncNodes() {
  const maxMcap = Math.max(...props.tickers.map((t) => t.marketCapUsd), 1)
  const minDim = Math.min(width, height)
  const existing = new Map(nodes.map((n) => [n.id, n]))
  nodes = props.tickers.map((t, i) => {
    const asset = ASSET_MAP[t.assetId]
    const prev = existing.get(t.assetId)
    // 初期配置は画面全体に広がる二重リング（中央密集を防ぐ）
    const angle = (i / Math.max(props.tickers.length, 1)) * Math.PI * 2
    const ring = i % 2 === 0 ? 0.32 : 0.55
    return {
      id: t.assetId,
      x: prev?.x ?? width / 2 + Math.cos(angle) * width * ring * 0.45,
      y: prev?.y ?? height / 2 + Math.sin(angle) * height * ring * 0.42,
      vx: prev?.vx ?? 0,
      vy: prev?.vy ?? 0,
      r: nodeRadius(t, maxMcap, minDim),
      color: asset?.color ?? '#888',
      symbol: asset?.symbol ?? t.assetId,
      changePct: t.change24hPct,
    }
  })
}

function physicsStep() {
  const cx = width / 2
  const cy = height / 2
  // ドラッグ中ノードには力を加算しない（積分がスキップされるため速度が減衰なしで
  // 蓄積し、離した瞬間に吹き飛ぶ: ISSUE-P8-10）
  for (const n of nodes) {
    if (n.id === dragId) continue
    // 中心へのごく弱い引力（強すぎると全バブルが中央に密集して読めなくなる）
    n.vx += (cx - n.x) * 0.00035
    n.vy += (cy - n.y) * 0.00035
  }
  // 反発（バブル同士の重なり解消 + ラベルが読める余白の確保）
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.hypot(dx, dy) || 0.01
      const minDist = a.r + b.r + Math.min(width, height) * 0.06
      if (dist < minDist) {
        const push = ((minDist - dist) / dist) * 0.1
        if (a.id !== dragId) {
          a.vx -= dx * push
          a.vy -= dy * push
        }
        if (b.id !== dragId) {
          b.vx += dx * push
          b.vy += dy * push
        }
      }
    }
  }
  // フローで結ばれたバブルはごく弱く引き寄せ合う（反発より常に弱く保つ）
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const maxAmount = Math.max(...props.flows.map((f) => f.amountUsd), 1)
  for (const f of props.flows) {
    const a = byId.get(f.fromAssetId)
    const b = byId.get(f.toAssetId)
    if (!a || !b) continue
    const strength = 0.00012 * (f.amountUsd / maxAmount)
    if (a.id !== dragId) {
      a.vx += (b.x - a.x) * strength
      a.vy += (b.y - a.y) * strength
    }
    if (b.id !== dragId) {
      b.vx += (a.x - b.x) * strength
      b.vy += (a.y - b.y) * strength
    }
  }
  for (const n of nodes) {
    // ドラッグ中のバブルはポインタ追従が優先（物理積分をスキップ）
    if (n.id === dragId) continue
    n.vx *= 0.9
    n.vy *= 0.9
    n.x += n.vx
    n.y += n.vy
    n.x = Math.max(n.r, Math.min(width - n.r, n.x))
    n.y = Math.max(n.r, Math.min(height - n.r, n.y))
  }
}

function drawArrow(ctx: CanvasRenderingContext2D, a: Node, b: Node, amount: number, maxAmount: number) {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const dist = Math.hypot(dx, dy)
  if (dist < a.r + b.r + 8) return
  const ux = dx / dist
  const uy = dy / dist
  const sx = a.x + ux * (a.r + 4)
  const sy = a.y + uy * (a.r + 4)
  const ex = b.x - ux * (b.r + 8)
  const ey = b.y - uy * (b.r + 8)
  const w = 1 + (amount / maxAmount) * 7 // 太さ = フロー量

  // 曲線（中点を法線方向にオフセット）
  const mx = (sx + ex) / 2 - uy * dist * 0.12
  const my = (sy + ey) / 2 + ux * dist * 0.12

  const grad = ctx.createLinearGradient(sx, sy, ex, ey)
  grad.addColorStop(0, `${a.color}33`)
  grad.addColorStop(1, `${b.color}bb`)
  ctx.strokeStyle = grad
  ctx.lineWidth = w
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(sx, sy)
  ctx.quadraticCurveTo(mx, my, ex, ey)
  ctx.stroke()

  // 矢じり
  const angle = Math.atan2(ey - my, ex - mx)
  const ah = 5 + w * 1.6
  ctx.fillStyle = `${b.color}dd`
  ctx.beginPath()
  ctx.moveTo(ex, ey)
  ctx.lineTo(ex - ah * Math.cos(angle - 0.42), ey - ah * Math.sin(angle - 0.42))
  ctx.lineTo(ex - ah * Math.cos(angle + 0.42), ey - ah * Math.sin(angle + 0.42))
  ctx.closePath()
  ctx.fill()

  // フロー粒子（曲線上を移動する光点で資金の流れを表現）
  const particles = Math.max(1, Math.round((amount / maxAmount) * 3))
  for (let p = 0; p < particles; p++) {
    const t = (particlePhase + p / particles) % 1
    const ix = (1 - t) ** 2 * sx + 2 * (1 - t) * t * mx + t ** 2 * ex
    const iy = (1 - t) ** 2 * sy + 2 * (1 - t) * t * my + t ** 2 * ey
    ctx.fillStyle = 'rgba(232,236,248,0.85)'
    ctx.beginPath()
    ctx.arc(ix, iy, 1.2 + w * 0.25, 0, Math.PI * 2)
    ctx.fill()
  }
}

function render() {
  const canvas = canvasRef.value
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  const dpr = window.devicePixelRatio || 1
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  physicsStep()
  particlePhase = (particlePhase + 0.004) % 1

  const byId = new Map(nodes.map((n) => [n.id, n]))
  const maxAmount = Math.max(...props.flows.map((f) => f.amountUsd), 1)
  for (const f of props.flows) {
    const a = byId.get(f.fromAssetId)
    const b = byId.get(f.toAssetId)
    if (a && b) drawArrow(ctx, a, b, f.amountUsd, maxAmount)
  }

  for (const n of nodes) {
    const up = n.changePct >= 0
    const glow = ctx.createRadialGradient(n.x, n.y, n.r * 0.3, n.x, n.y, n.r)
    glow.addColorStop(0, `${n.color}55`)
    glow.addColorStop(1, `${n.color}18`)
    ctx.fillStyle = glow
    ctx.beginPath()
    ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = n.id === props.selectedId ? '#ffffff' : up ? 'rgba(34,197,139,0.8)' : 'rgba(240,80,110,0.8)'
    ctx.lineWidth = n.id === props.selectedId ? 2.5 : 1.5
    ctx.stroke()

    ctx.fillStyle = '#e8ecf8'
    ctx.textAlign = 'center'
    ctx.font = `700 ${Math.max(10, n.r * 0.42)}px system-ui`
    ctx.fillText(n.symbol, n.x, n.y - 2)
    ctx.font = `600 ${Math.max(8, n.r * 0.28)}px monospace`
    ctx.fillStyle = up ? '#22c58b' : '#f0506e'
    ctx.fillText(fmtPct(n.changePct), n.x, n.y + Math.max(10, n.r * 0.34))
  }

  raf = requestAnimationFrame(render)
}

function resize() {
  const wrap = wrapRef.value
  const canvas = canvasRef.value
  if (!wrap || !canvas) return
  width = wrap.clientWidth
  height = Math.max(360, Math.min(window.innerHeight * 0.62, 560))
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = height * dpr
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  syncNodes()
}

// --- ドラッグ / タッチ操作 ---
// ドラッグでバブルを引っ張って投げられる。移動が小さい場合はタップ = 選択として扱う。
let dragId: string | null = null
let dragMoved = 0
let lastPointer = { x: 0, y: 0 }

function canvasPos(e: PointerEvent): { x: number; y: number } {
  const rect = canvasRef.value!.getBoundingClientRect()
  return { x: e.clientX - rect.left, y: e.clientY - rect.top }
}

function onPointerDown(e: PointerEvent) {
  if (!canvasRef.value) return
  const { x, y } = canvasPos(e)
  lastPointer = { x, y }
  dragMoved = 0
  const hit = nodes.find((n) => Math.hypot(n.x - x, n.y - y) <= n.r + 6)
  if (hit) {
    dragId = hit.id
    canvasRef.value.setPointerCapture(e.pointerId)
  }
}

function onPointerMove(e: PointerEvent) {
  if (!dragId || !canvasRef.value) return
  const { x, y } = canvasPos(e)
  dragMoved += Math.hypot(x - lastPointer.x, y - lastPointer.y)
  const n = nodes.find((v) => v.id === dragId)
  if (n) {
    // 離した瞬間に慣性で飛ぶよう、追従差分を速度として蓄える
    n.vx = (x - n.x) * 0.35
    n.vy = (y - n.y) * 0.35
    n.x = Math.max(n.r, Math.min(width - n.r, x))
    n.y = Math.max(n.r, Math.min(height - n.r, y))
  }
  lastPointer = { x, y }
  e.preventDefault()
}

function onPointerUp(e: PointerEvent) {
  const wasDragging = dragId
  const { x, y } = canvasPos(e)
  if (wasDragging) {
    // 移動量が小さければタップ = 選択
    if (dragMoved < 8) emit('select', wasDragging)
  } else {
    const hit = nodes.find((n) => Math.hypot(n.x - x, n.y - y) <= n.r + 6)
    emit('select', hit ? hit.id : null)
  }
  dragId = null
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  resize()
  resizeObserver = new ResizeObserver(resize)
  if (wrapRef.value) resizeObserver.observe(wrapRef.value)
  raf = requestAnimationFrame(render)
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
})
watch(
  () => props.tickers,
  () => syncNodes(),
)
</script>

<template>
  <div ref="wrapRef" class="bubble-wrap">
    <canvas
      ref="canvasRef"
      role="img"
      aria-label="銘柄間の資金フローを示すバブルマップ。ドラッグでバブルを移動できます"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="dragId = null"
    />
  </div>
</template>

<style scoped>
.bubble-wrap {
  width: 100%;
  border-radius: var(--radius);
  overflow: hidden;
  background: radial-gradient(ellipse at 50% 30%, #101830 0%, #0b1020 70%);
  border: 1px solid var(--border);
}
canvas {
  display: block;
  /* ドラッグ操作を優先（マップ上ではスクロールより操作性を優先する） */
  touch-action: none;
  cursor: grab;
}
canvas:active { cursor: grabbing; }
</style>

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
  const ratio = Math.sqrt(Math.max(t.marketCapUsd, 1) / Math.max(maxMcap, 1))
  return Math.max(minDim * 0.028, ratio * minDim * 0.13)
}

/** ティッカー更新時にノードを同期（既存ノードの位置は保持: 状態保護） */
function syncNodes() {
  const maxMcap = Math.max(...props.tickers.map((t) => t.marketCapUsd), 1)
  const minDim = Math.min(width, height)
  const existing = new Map(nodes.map((n) => [n.id, n]))
  nodes = props.tickers.map((t, i) => {
    const asset = ASSET_MAP[t.assetId]
    const prev = existing.get(t.assetId)
    const angle = (i / Math.max(props.tickers.length, 1)) * Math.PI * 2
    return {
      id: t.assetId,
      x: prev?.x ?? width / 2 + Math.cos(angle) * minDim * 0.3,
      y: prev?.y ?? height / 2 + Math.sin(angle) * minDim * 0.3,
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
  for (const n of nodes) {
    // 中心へのゆるい引力
    n.vx += (cx - n.x) * 0.0012
    n.vy += (cy - n.y) * 0.0012
  }
  // 反発（バブル同士の重なり解消）
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i]
      const b = nodes[j]
      const dx = b.x - a.x
      const dy = b.y - a.y
      const dist = Math.hypot(dx, dy) || 0.01
      const minDist = a.r + b.r + 14
      if (dist < minDist) {
        const push = ((minDist - dist) / dist) * 0.06
        a.vx -= dx * push
        a.vy -= dy * push
        b.vx += dx * push
        b.vy += dy * push
      }
    }
  }
  // フローで結ばれたバブルは弱く引き寄せ合う（資金経路が空間的に近づく）
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const maxAmount = Math.max(...props.flows.map((f) => f.amountUsd), 1)
  for (const f of props.flows) {
    const a = byId.get(f.fromAssetId)
    const b = byId.get(f.toAssetId)
    if (!a || !b) continue
    const strength = 0.0004 * (f.amountUsd / maxAmount)
    a.vx += (b.x - a.x) * strength
    a.vy += (b.y - a.y) * strength
    b.vx += (a.x - b.x) * strength
    b.vy += (a.y - b.y) * strength
  }
  for (const n of nodes) {
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

function onPointer(e: PointerEvent) {
  const canvas = canvasRef.value
  if (!canvas) return
  const rect = canvas.getBoundingClientRect()
  const x = e.clientX - rect.left
  const y = e.clientY - rect.top
  const hit = nodes.find((n) => Math.hypot(n.x - x, n.y - y) <= n.r + 6)
  emit('select', hit ? hit.id : null)
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
      aria-label="銘柄間の資金フローを示すバブルマップ"
      @pointerdown="onPointer"
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
  touch-action: manipulation;
}
canvas { display: block; }
</style>

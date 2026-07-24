<script setup lang="ts">
import { fmtUsd } from '~/shared/format'

// 詳細ライン チャート（7日・レスポンシブ幅）。軸ラベル付き。
const props = defineProps<{ values: number[]; color?: string }>()

const wrapRef = ref<HTMLDivElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const HEIGHT = 220

function draw() {
  const canvas = canvasRef.value
  const wrap = wrapRef.value
  if (!canvas || !wrap) return
  const width = wrap.clientWidth
  const dpr = window.devicePixelRatio || 1
  canvas.width = width * dpr
  canvas.height = HEIGHT * dpr
  canvas.style.width = `${width}px`
  canvas.style.height = `${HEIGHT}px`
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, width, HEIGHT)

  const values = props.values
  if (values.length < 2) return
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const padL = 8
  const padR = 64
  const padY = 14
  const plotW = width - padL - padR
  const stepX = plotW / (values.length - 1)
  const yOf = (v: number) => padY + (1 - (v - min) / range) * (HEIGHT - padY * 2)

  // 水平グリッド + 右軸ラベル
  ctx.font = '10px monospace'
  ctx.textBaseline = 'middle'
  for (let g = 0; g <= 4; g++) {
    const v = min + (range * g) / 4
    const y = yOf(v)
    ctx.strokeStyle = 'rgba(38,48,79,0.6)'
    ctx.beginPath()
    ctx.moveTo(padL, y)
    ctx.lineTo(padL + plotW, y)
    ctx.stroke()
    ctx.fillStyle = '#5c6a8f'
    ctx.fillText(fmtUsd(v), padL + plotW + 6, y)
  }

  const color = props.color || '#4f7cff'
  ctx.beginPath()
  values.forEach((v, i) => {
    const x = padL + i * stepX
    const y = yOf(v)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.lineTo(padL + plotW, HEIGHT - padY)
  ctx.lineTo(padL, HEIGHT - padY)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, HEIGHT)
  grad.addColorStop(0, `${color}44`)
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad
  ctx.fill()
}

let resizeObserver: ResizeObserver | null = null
onMounted(() => {
  draw()
  resizeObserver = new ResizeObserver(draw)
  if (wrapRef.value) resizeObserver.observe(wrapRef.value)
})
onBeforeUnmount(() => resizeObserver?.disconnect())
watch(() => props.values, draw)
</script>

<template>
  <div ref="wrapRef" class="chart-wrap">
    <canvas ref="canvasRef" aria-label="価格チャート" role="img" />
  </div>
</template>

<style scoped>
.chart-wrap { width: 100%; }
</style>

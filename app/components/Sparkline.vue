<script setup lang="ts">
// 軽量スパークライン（Canvas 2D）。約165×40px で7日価格推移を描画する。
const props = withDefaults(
  defineProps<{ values: number[]; width?: number; height?: number; up?: boolean }>(),
  { width: 165, height: 40 },
)

const canvasRef = ref<HTMLCanvasElement | null>(null)

function draw() {
  const canvas = canvasRef.value
  if (!canvas) return
  const dpr = window.devicePixelRatio || 1
  canvas.width = props.width * dpr
  canvas.height = props.height * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  ctx.clearRect(0, 0, props.width, props.height)

  const values = props.values
  if (values.length < 2) return
  const min = Math.min(...values)
  const max = Math.max(...values)
  const range = max - min || 1
  const stepX = props.width / (values.length - 1)
  const pad = 3

  const color = props.up ? '#22c58b' : '#f0506e'
  ctx.beginPath()
  values.forEach((v, i) => {
    const x = i * stepX
    const y = pad + (1 - (v - min) / range) * (props.height - pad * 2)
    if (i === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  })
  ctx.strokeStyle = color
  ctx.lineWidth = 1.5
  ctx.stroke()

  // 塗り（グラデーション）
  ctx.lineTo(props.width, props.height)
  ctx.lineTo(0, props.height)
  ctx.closePath()
  const grad = ctx.createLinearGradient(0, 0, 0, props.height)
  grad.addColorStop(0, props.up ? 'rgba(34,197,139,0.25)' : 'rgba(240,80,110,0.25)')
  grad.addColorStop(1, 'rgba(0,0,0,0)')
  ctx.fillStyle = grad
  ctx.fill()
}

onMounted(draw)
watch(() => [props.values, props.up], draw, { deep: false })
</script>

<template>
  <canvas
    ref="canvasRef"
    :style="{ width: `${width}px`, height: `${height}px` }"
    aria-hidden="true"
  />
</template>

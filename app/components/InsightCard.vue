<script setup lang="ts">
import { Minus, TrendingDown, TrendingUp } from '@lucide/vue'
import { fmtAgo } from '~/shared/format'
import type { Insight } from '~/shared/types'

const props = defineProps<{ insight: Insight }>()

const stanceMeta = computed(() => {
  switch (props.insight.stance) {
    case 'bullish':
      return { label: '強気', cls: 'badge-up', icon: markRaw(TrendingUp) }
    case 'bearish':
      return { label: '弱気', cls: 'badge-down', icon: markRaw(TrendingDown) }
    default:
      return { label: '中立', cls: 'badge-accent', icon: markRaw(Minus) }
  }
})
</script>

<template>
  <div class="card">
    <div class="card-title">
      <span class="badge" :class="stanceMeta.cls" style="font-size: 0.85rem; display: inline-flex; align-items: center; gap: 4px">
        <component :is="stanceMeta.icon" :size="15" aria-hidden="true" /> {{ stanceMeta.label }}
      </span>
      <span class="small dim mono">確信度 {{ insight.confidence }}%</span>
    </div>
    <div class="confidence-bar" aria-hidden="true">
      <div
        class="confidence-fill"
        :style="{
          width: `${insight.confidence}%`,
          background: insight.stance === 'bullish' ? 'var(--up)' : insight.stance === 'bearish' ? 'var(--down)' : 'var(--accent)',
        }"
      />
    </div>
    <p style="margin-top: 10px">{{ insight.summary }}</p>

    <h3>根拠</h3>
    <ul class="small">
      <li v-for="(r, i) in insight.reasons" :key="i">{{ r }}</li>
    </ul>

    <h3 class="down">リスク</h3>
    <ul class="small">
      <li v-for="(r, i) in insight.risks" :key="i">{{ r }}</li>
    </ul>

    <div class="src xs faint">
      <span
        class="badge"
        :class="insight.engine === 'vertex-ai' ? 'badge-accent' : 'badge-warn'"
      >
        {{ insight.engine === 'vertex-ai' ? 'Vertex AI (Gemini)' : 'テクニカル分析（AI未接続）' }}
      </span>
      <span>ソース: {{ insight.sources.join(' / ') }}</span>
      <span>生成: {{ fmtAgo(insight.generatedAt) }}</span>
    </div>
  </div>
</template>

<style scoped>
.confidence-bar { height: 5px; background: var(--bg); border-radius: 3px; overflow: hidden; }
.confidence-fill { height: 100%; border-radius: 3px; transition: width 0.4s; }
ul { margin: 4px 0 12px; padding-left: 20px; }
.src { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
</style>

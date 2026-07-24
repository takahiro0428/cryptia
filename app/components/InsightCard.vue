<script setup lang="ts">
import { ArrowDownToLine, ArrowUpFromLine, Minus, TrendingDown, TrendingUp } from '@lucide/vue'
import { fmtAgo, fmtUsd } from '~/shared/format'
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

    <!-- ロング/ショート別のおすすめエントリーレンジ -->
    <template v-if="insight.entryRanges && insight.entryRanges.long.maxUsd > 0">
      <h3>おすすめエントリーレンジ</h3>
      <div class="ranges">
        <div class="range">
          <span class="side up"><ArrowDownToLine :size="14" aria-hidden="true" /> ロング</span>
          <span class="mono bold">{{ fmtUsd(insight.entryRanges.long.minUsd) }} 〜 {{ fmtUsd(insight.entryRanges.long.maxUsd) }}</span>
          <span class="xs dim">{{ insight.entryRanges.long.note }}</span>
        </div>
        <div class="range">
          <span class="side down"><ArrowUpFromLine :size="14" aria-hidden="true" /> ショート</span>
          <span class="mono bold">{{ fmtUsd(insight.entryRanges.short.minUsd) }} 〜 {{ fmtUsd(insight.entryRanges.short.maxUsd) }}</span>
          <span class="xs dim">{{ insight.entryRanges.short.note }}</span>
        </div>
      </div>
      <p class="xs faint" style="margin: 4px 0 10px">
        指値の参考ゾーンです。約定を保証するものではなく、急変時は水準が無効になります。
      </p>
    </template>

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
.ranges { display: flex; flex-direction: column; gap: 6px; margin: 4px 0 6px; }
.range {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  font-size: 0.85rem;
}
.range .side { display: inline-flex; align-items: center; gap: 4px; font-weight: 700; min-width: 84px; }
ul { margin: 4px 0 12px; padding-left: 20px; }
.src { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin-top: 8px; }
</style>

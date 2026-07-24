<script setup lang="ts">
import { ASSET_MAP, ASSET_CLASS_LABELS } from '~/shared/assets'
import { fmtPct, fmtUsd } from '~/shared/format'
import type { Ticker } from '~/shared/types'

const props = defineProps<{ ticker: Ticker; selected?: boolean }>()
defineEmits<{ select: [assetId: string] }>()

const asset = computed(() => ASSET_MAP[props.ticker.assetId])
const isUp = computed(() => props.ticker.change24hPct >= 0)
</script>

<template>
  <button
    v-if="asset"
    class="price-card"
    :class="{ selected }"
    type="button"
    @click="$emit('select', ticker.assetId)"
  >
    <div class="head">
      <span class="sym" :style="{ color: asset.color }">{{ asset.symbol }}</span>
      <span class="badge">{{ ASSET_CLASS_LABELS[asset.class] }}</span>
    </div>
    <div class="name dim small">{{ asset.nameJa }}</div>
    <div class="price mono bold">{{ fmtUsd(ticker.priceUsd) }}</div>
    <div class="mono small" :class="isUp ? 'up' : 'down'">{{ fmtPct(ticker.change24hPct) }} <span class="faint xs">24h</span></div>
    <Sparkline :values="ticker.sparkline7d" :up="ticker.change7dPct >= 0" :width="140" :height="34" />
  </button>
</template>

<style scoped>
.price-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 12px 14px;
  color: var(--text);
  cursor: pointer;
  transition: border-color 0.15s;
}
.price-card:hover { border-color: var(--accent); }
.price-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.head { display: flex; justify-content: space-between; align-items: center; gap: 6px; }
.sym { font-weight: 800; font-size: 1rem; }
.price { font-size: 1.05rem; margin-top: 2px; }
</style>

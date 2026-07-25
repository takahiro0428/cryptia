<script setup lang="ts">
import { Bot, FlaskConical, X } from '@lucide/vue'
import { ASSET_MAP, ASSET_CLASS_LABELS } from '~/shared/assets'
import { fmtPct, fmtUsd } from '~/shared/format'
import type { Ticker } from '~/shared/types'

/**
 * 銘柄詳細カード（マーケット画面のその場展開ビュー）。
 * タップしたカードの位置でアニメーション展開する（最上部へ戻る操作を不要にする）。
 */
const props = defineProps<{ ticker: Ticker }>()
defineEmits<{ close: [] }>()

const asset = computed(() => ASSET_MAP[props.ticker.assetId])
const rootRef = ref<HTMLElement | null>(null)

onMounted(() => {
  // 展開時にカード全体が視界に入るよう追従スクロール。
  // scaleY アニメーション中は矩形が縮小されておりスクロール量が過小になるため、
  // アニメーション完了後に実行する（ISSUE-P8-17）。
  // reduced-motion 等で animationend が発火しない場合はタイムアウトで代替
  const el = rootRef.value
  if (!el) return
  let done = false
  const scroll = () => {
    if (done) return
    done = true
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
  }
  el.addEventListener('animationend', scroll, { once: true })
  setTimeout(scroll, 350)
})
</script>

<template>
  <section v-if="asset" ref="rootRef" class="card detail-card" aria-label="銘柄詳細">
    <div class="card-title">
      <h2>
        <span :style="{ color: asset.color }">{{ asset.symbol }}</span>
        {{ asset.nameJa }}
        <span class="badge">{{ ASSET_CLASS_LABELS[asset.class] }}</span>
      </h2>
      <button class="btn btn-sm btn-ghost" type="button" aria-label="詳細を閉じる" @click="$emit('close')">
        <X :size="16" aria-hidden="true" />
      </button>
    </div>
    <div class="detail-stats">
      <div>
        <div class="xs faint">価格</div>
        <div class="mono bold">{{ fmtUsd(ticker.priceUsd) }}</div>
      </div>
      <div>
        <div class="xs faint">1h</div>
        <div class="mono" :class="ticker.change1hPct >= 0 ? 'up' : 'down'">{{ fmtPct(ticker.change1hPct) }}</div>
      </div>
      <div>
        <div class="xs faint">24h</div>
        <div class="mono" :class="ticker.change24hPct >= 0 ? 'up' : 'down'">{{ fmtPct(ticker.change24hPct) }}</div>
      </div>
      <div>
        <div class="xs faint">7d</div>
        <div class="mono" :class="ticker.change7dPct >= 0 ? 'up' : 'down'">{{ fmtPct(ticker.change7dPct) }}</div>
      </div>
      <div>
        <div class="xs faint">時価総額</div>
        <div class="mono">{{ fmtUsd(ticker.marketCapUsd) }}</div>
      </div>
      <div>
        <div class="xs faint">24h出来高</div>
        <div class="mono">{{ fmtUsd(ticker.volume24hUsd) }}</div>
      </div>
    </div>
    <PriceChart :values="ticker.sparkline7d" :color="asset.color" />
    <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap">
      <NuxtLink :to="`/insights?asset=${asset.id}`" class="btn btn-primary btn-sm">
        <Bot :size="15" aria-hidden="true" /> AI分析を見る
      </NuxtLink>
      <NuxtLink to="/trade/demo" class="btn btn-sm">
        <FlaskConical :size="15" aria-hidden="true" /> デモトレード
      </NuxtLink>
    </div>
  </section>
</template>

<style scoped>
.detail-card {
  /* グリッド内でその場展開（全カラムに広がる） */
  grid-column: 1 / -1;
  border-color: var(--accent);
  animation: detail-expand 0.28s cubic-bezier(0.2, 0.9, 0.3, 1);
  transform-origin: top center;
}
@keyframes detail-expand {
  from { opacity: 0; transform: scaleY(0.6); }
  to { opacity: 1; transform: scaleY(1); }
}
@media (prefers-reduced-motion: reduce) {
  .detail-card { animation: none; }
}
.detail-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  margin-bottom: 12px;
}
@media (min-width: 768px) {
  .detail-stats { grid-template-columns: repeat(6, 1fr); }
}
</style>

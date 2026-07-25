<script setup lang="ts">
import { Radio, TriangleAlert } from '@lucide/vue'
import { ASSET_MAP, ASSETS } from '~/shared/assets'
import { fmtAgo } from '~/shared/format'
import type { AssetClass } from '~/shared/types'
import { useMarketStore } from '~/stores/market'

// マーケットダッシュボード（UC-1 / F-01）
// 詳細はタップしたカードの位置でその場展開する（最上部へ戻る操作を不要にする）
const market = useMarketStore()
const selectedId = ref<string | null>(null)
const classFilter = ref<AssetClass | 'all'>('all')

const filteredTickers = computed(() =>
  market.tickers.filter(
    (t) => classFilter.value === 'all' || ASSET_MAP[t.assetId]?.class === classFilter.value,
  ),
)

const CLASS_TABS: { key: AssetClass | 'all'; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'crypto', label: '仮想通貨' },
  { key: 'stock-token', label: '株式トークン' },
  { key: 'gold-token', label: 'ゴールド' },
]

// フィルタ変更で選択銘柄が非表示になる場合は選択解除（幽霊展開の防止）
watch(classFilter, () => {
  if (selectedId.value && !filteredTickers.value.some((t) => t.assetId === selectedId.value)) {
    selectedId.value = null
  }
})

useHead({ title: 'マーケット | Cryptia' })
</script>

<template>
  <div>
    <DisclaimerBanner />
    <div class="card-title">
      <h1>マーケット</h1>
      <span class="small dim live-row" aria-live="polite">
        <span v-if="market.streaming" class="badge badge-up live-badge">
          <Radio :size="12" aria-hidden="true" /> LIVE
        </span>
        <template v-if="market.lastUpdatedAt">更新: {{ fmtAgo(market.lastUpdatedAt) }}</template>
      </span>
    </div>

    <div v-if="market.usingMockData" class="disclaimer" role="alert">
      <TriangleAlert :size="14" class="icon-inline" aria-hidden="true" />
      価格 API に接続できないため参考データ（モック）を表示しています。表示中の価格は実勢と異なります。
    </div>

    <div class="tabs" role="tablist" style="margin-bottom: 12px">
      <button
        v-for="tab in CLASS_TABS"
        :key="tab.key"
        class="tab"
        :class="{ active: classFilter === tab.key }"
        role="tab"
        :aria-selected="classFilter === tab.key"
        type="button"
        @click="classFilter = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <!-- 価格カード一覧（タップで直下にその場展開） -->
    <div v-if="market.loading && market.tickers.length === 0" class="grid grid-cards">
      <div v-for="i in 8" :key="i" class="skeleton" style="height: 150px" />
    </div>
    <div v-else class="grid grid-cards">
      <template v-for="t in filteredTickers" :key="t.assetId">
        <PriceCard
          :ticker="t"
          :selected="t.assetId === selectedId"
          @select="(id) => (selectedId = selectedId === id ? null : id)"
        />
        <AssetDetailCard
          v-if="t.assetId === selectedId"
          :ticker="t"
          @close="selectedId = null"
        />
      </template>
    </div>

    <p class="xs faint center" style="margin-top: 16px">
      対象銘柄: {{ ASSETS.length }} 銘柄 / 主要銘柄は WebSocket で即時更新 / データ: Binance・CoinGecko
    </p>
  </div>
</template>

<style scoped>
.live-row { display: inline-flex; align-items: center; gap: 8px; }
.live-badge { display: inline-flex; align-items: center; gap: 3px; }
.live-badge svg { animation: live-pulse 1.6s ease-in-out infinite; }
@keyframes live-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .live-badge svg { animation: none; }
}
</style>

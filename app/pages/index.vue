<script setup lang="ts">
import { ASSET_MAP, ASSET_CLASS_LABELS, ASSETS } from '~/shared/assets'
import { fmtAgo, fmtPct, fmtUsd } from '~/shared/format'
import type { AssetClass } from '~/shared/types'
import { useMarketStore } from '~/stores/market'

// マーケットダッシュボード（UC-1 / F-01）
const market = useMarketStore()
const selectedId = ref<string | null>(null)
const classFilter = ref<AssetClass | 'all'>('all')

const filteredTickers = computed(() =>
  market.tickers.filter(
    (t) => classFilter.value === 'all' || ASSET_MAP[t.assetId]?.class === classFilter.value,
  ),
)
const selectedTicker = computed(() =>
  selectedId.value ? market.tickerOf(selectedId.value) : undefined,
)
const selectedAsset = computed(() => (selectedId.value ? ASSET_MAP[selectedId.value] : undefined))

const CLASS_TABS: { key: AssetClass | 'all'; label: string }[] = [
  { key: 'all', label: 'すべて' },
  { key: 'crypto', label: '仮想通貨' },
  { key: 'stock-token', label: '株式トークン' },
  { key: 'gold-token', label: 'ゴールド' },
]

useHead({ title: 'マーケット | Cryptia' })
</script>

<template>
  <div>
    <DisclaimerBanner />
    <div class="card-title">
      <h1>マーケット</h1>
      <span class="small dim" aria-live="polite">
        <template v-if="market.lastUpdatedAt">更新: {{ fmtAgo(market.lastUpdatedAt) }}</template>
      </span>
    </div>

    <div v-if="market.usingMockData" class="disclaimer" role="alert">
      ⚠️ 価格 API に接続できないため参考データ（モック）を表示しています。表示中の価格は実勢と異なります。
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

    <!-- 選択銘柄の詳細 -->
    <section v-if="selectedTicker && selectedAsset" class="card" style="margin-bottom: 12px">
      <div class="card-title">
        <h2>
          <span :style="{ color: selectedAsset.color }">{{ selectedAsset.symbol }}</span>
          {{ selectedAsset.nameJa }}
          <span class="badge">{{ ASSET_CLASS_LABELS[selectedAsset.class] }}</span>
        </h2>
        <button class="btn btn-sm btn-ghost" type="button" @click="selectedId = null">閉じる</button>
      </div>
      <div class="detail-stats">
        <div>
          <div class="xs faint">価格</div>
          <div class="mono bold">{{ fmtUsd(selectedTicker.priceUsd) }}</div>
        </div>
        <div>
          <div class="xs faint">1h</div>
          <div class="mono" :class="selectedTicker.change1hPct >= 0 ? 'up' : 'down'">{{ fmtPct(selectedTicker.change1hPct) }}</div>
        </div>
        <div>
          <div class="xs faint">24h</div>
          <div class="mono" :class="selectedTicker.change24hPct >= 0 ? 'up' : 'down'">{{ fmtPct(selectedTicker.change24hPct) }}</div>
        </div>
        <div>
          <div class="xs faint">7d</div>
          <div class="mono" :class="selectedTicker.change7dPct >= 0 ? 'up' : 'down'">{{ fmtPct(selectedTicker.change7dPct) }}</div>
        </div>
        <div>
          <div class="xs faint">時価総額</div>
          <div class="mono">{{ fmtUsd(selectedTicker.marketCapUsd) }}</div>
        </div>
        <div>
          <div class="xs faint">24h出来高</div>
          <div class="mono">{{ fmtUsd(selectedTicker.volume24hUsd) }}</div>
        </div>
      </div>
      <PriceChart :values="selectedTicker.sparkline7d" :color="selectedAsset.color" />
      <div style="display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap">
        <NuxtLink :to="`/insights?asset=${selectedAsset.id}`" class="btn btn-primary btn-sm">🤖 AI分析を見る</NuxtLink>
        <NuxtLink to="/trade/demo" class="btn btn-sm">🧪 デモトレード</NuxtLink>
      </div>
    </section>

    <!-- 価格カード一覧 -->
    <div v-if="market.loading && market.tickers.length === 0" class="grid grid-cards">
      <div v-for="i in 8" :key="i" class="skeleton" style="height: 150px" />
    </div>
    <div v-else class="grid grid-cards">
      <PriceCard
        v-for="t in filteredTickers"
        :key="t.assetId"
        :ticker="t"
        :selected="t.assetId === selectedId"
        @select="(id) => (selectedId = selectedId === id ? null : id)"
      />
    </div>

    <p class="xs faint center" style="margin-top: 16px">
      対象銘柄: {{ ASSETS.length }} 銘柄 / 15秒間隔で自動更新 / データ: CoinGecko
    </p>
  </div>
</template>

<style scoped>
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

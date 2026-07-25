<script setup lang="ts">
import { Newspaper, RefreshCw } from '@lucide/vue'
import { ASSET_MAP, ASSETS } from '~/shared/assets'
import { fmtAgo } from '~/shared/format'
import type { Horizon } from '~/shared/types'
import { useInsightsStore } from '~/stores/insights'
import { useMarketStore } from '~/stores/market'
import { useStrategyStore } from '~/stores/strategy'

// AI インサイト（UC-3 / F-03）: 短期・中期・長期タブ
const market = useMarketStore()
const insights = useInsightsStore()
const strategy = useStrategyStore()
const route = useRoute()

const assetId = ref<string>(
  typeof route.query.asset === 'string' && ASSET_MAP[route.query.asset]
    ? route.query.asset
    : 'bitcoin',
)
const horizon = ref<Horizon>('short')

const HORIZON_TABS: { key: Horizon; label: string }[] = [
  { key: 'short', label: '短期 〜1週間' },
  { key: 'mid', label: '中期 〜1ヶ月' },
  { key: 'long', label: '長期 〜1年' },
]

const ticker = computed(() => market.tickerOf(assetId.value))
const currentInsight = computed(() => insights.insightFor(assetId.value, horizon.value))
const loading = computed(() => insights.isLoading(assetId.value, horizon.value))

async function load(force = false) {
  if (!ticker.value) return
  await insights.fetchInsight(ticker.value, horizon.value, force)
}

// 銘柄・時間軸・適用戦略の変更、および初回ティッカー到着で自動生成
// （戦略はキャッシュキーに含まれるため、切替時は該当キーの生成/取得が走る）
watch(
  [assetId, horizon, () => ticker.value?.assetId, () => strategy.activeByContext.insights],
  () => void load(),
  { immediate: true },
)
onMounted(() => {
  void strategy.restoreState()
  void insights.fetchNews()
})

useHead({ title: 'AI分析 | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1>AI トレードアドバイス</h1>
    </div>
    <DisclaimerBanner />

    <label class="field">
      <span>分析対象の銘柄</span>
      <select v-model="assetId" class="input">
        <option v-for="a in ASSETS" :key="a.id" :value="a.id">
          {{ a.symbol }} — {{ a.nameJa }}
        </option>
      </select>
    </label>

    <div class="tabs" role="tablist" style="margin-bottom: 12px">
      <button
        v-for="tab in HORIZON_TABS"
        :key="tab.key"
        class="tab"
        :class="{ active: horizon === tab.key }"
        role="tab"
        :aria-selected="horizon === tab.key"
        type="button"
        @click="horizon = tab.key"
      >
        {{ tab.label }}
      </button>
    </div>

    <StrategyPicker context="insights" />

    <div v-if="loading && !currentInsight" class="skeleton" style="height: 260px" />
    <template v-else-if="currentInsight">
      <InsightCard :insight="currentInsight" />
      <div style="display: flex; justify-content: flex-end; margin-top: 8px">
        <button class="btn btn-sm" type="button" :disabled="loading" @click="load(true)">
          <RefreshCw :size="14" aria-hidden="true" />
          {{ loading ? '生成中…' : '再生成' }}
        </button>
      </div>
    </template>
    <div v-else class="card dim">価格データの取得を待っています…</div>

    <!-- ニュースコンテキスト（AI が参照する情報源の透明化: BR-4） -->
    <section class="card" style="margin-top: 16px">
      <div class="card-title">
        <h2><Newspaper :size="17" class="icon-inline" aria-hidden="true" />市場ニュース</h2>
        <span class="xs faint">AI 分析の参照ソース</span>
      </div>
      <ul v-if="insights.news.length > 0" class="news-list">
        <li v-for="(n, i) in insights.news.slice(0, 10)" :key="i">
          <!-- https のみリンク化（フィード汚染による javascript: URL 対策） -->
          <a v-if="n.url.startsWith('https://')" :href="n.url" target="_blank" rel="noopener noreferrer">{{ n.title }}</a>
          <span v-else>{{ n.title }}</span>
          <span class="xs faint">{{ n.source }} ・ {{ fmtAgo(n.publishedAt) }}</span>
        </li>
      </ul>
      <p v-else-if="insights.newsLoaded" class="dim small">
        ニュースを取得できませんでした（CRYPTIA-E103）。AI はテクニカル指標のみで分析します。
      </p>
      <div v-else class="skeleton" style="height: 80px" />
    </section>
  </div>
</template>

<style scoped>
.news-list { list-style: none; margin: 0; padding: 0; }
.news-list li {
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 0.85rem;
}
.news-list li:last-child { border-bottom: none; }
</style>

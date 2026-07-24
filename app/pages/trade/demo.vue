<script setup lang="ts">
import { ASSET_MAP, ASSETS } from '~/shared/assets'
import { fmtPct, fmtQty, fmtTime, fmtUsd } from '~/shared/format'
import { useDemoTradeStore, type EngineMode } from '~/stores/demoTrade'
import { useMarketStore } from '~/stores/market'
import { useStrategyStore } from '~/stores/strategy'

// AI デモトレード（UC-4 / F-04）
const demo = useDemoTradeStore()
const market = useMarketStore()
const strategy = useStrategyStore()

const initialUsd = ref(10_000)
const engineMode = ref<EngineMode>('logic')
const selectedIds = ref<string[]>(['bitcoin', 'ethereum', 'solana'])
const showRecommend = ref(false)

const recommendations = computed(() => (showRecommend.value ? demo.recommendedAssets(4) : []))

function toggleAsset(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((v) => v !== id)
    : [...selectedIds.value, id]
}

function applyRecommendation() {
  const rec = demo.recommendedAssets(4)
  if (rec.length > 0) selectedIds.value = rec.map((r) => r.assetId)
  showRecommend.value = true
}

const equityValues = computed(() => demo.portfolio?.equityCurve.map((p) => p.equityUsd) ?? [])
const positionRows = computed(() => {
  const prices = market.priceMap
  return (demo.portfolio?.positions ?? []).map((p) => {
    const price = prices[p.assetId] ?? p.avgCostUsd
    const valueUsd = p.quantity * price
    const pnlPct = p.avgCostUsd > 0 ? ((price - p.avgCostUsd) / p.avgCostUsd) * 100 : 0
    return { ...p, price, valueUsd, pnlPct, symbol: ASSET_MAP[p.assetId]?.symbol ?? p.assetId }
  })
})

onMounted(async () => {
  await strategy.restoreState()
  await demo.restoreState()
})
useHead({ title: 'デモトレード | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1>🧪 AI デモトレード</h1>
      <span v-if="demo.running" class="badge badge-up">● 自動売買 実行中</span>
    </div>

    <!-- 設定フォーム（セッション未開始時） -->
    <section v-if="!demo.portfolio" class="card">
      <h2>新しいセッションを開始</h2>
      <label class="field">
        <span>初期資金（USD）</span>
        <input v-model.number="initialUsd" type="number" class="input" min="100" step="100" inputmode="numeric" />
      </label>

      <div class="field">
        <span class="small dim">取引エンジン</span>
        <div class="tabs" style="max-width: 420px">
          <button class="tab" :class="{ active: engineMode === 'logic' }" type="button" @click="engineMode = 'logic'">
            ロジック（オフライン可）
          </button>
          <button class="tab" :class="{ active: engineMode === 'ai' }" type="button" @click="engineMode = 'ai'">
            AI（Vertex AI 判断）
          </button>
        </div>
      </div>

      <div class="field">
        <span class="small dim">適用戦略: <b>{{ strategy.activeDoc.name }}</b>（<NuxtLink to="/strategy">変更</NuxtLink>）</span>
      </div>

      <div class="field">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
          <span class="small dim">取引対象銘柄（{{ selectedIds.length }} 選択中）</span>
          <button class="btn btn-sm" type="button" @click="applyRecommendation">🤖 AI のおすすめを使う</button>
        </div>
        <div v-if="recommendations.length > 0" class="rec-box small">
          <div v-for="r in recommendations" :key="r.assetId" class="xs dim">
            <b>{{ ASSET_MAP[r.assetId]?.symbol }}</b>（確信度 {{ r.confidence }}%）: {{ r.summary }}
          </div>
        </div>
        <div class="asset-chips">
          <button
            v-for="a in ASSETS"
            :key="a.id"
            class="chip"
            :class="{ on: selectedIds.includes(a.id) }"
            type="button"
            @click="toggleAsset(a.id)"
          >
            {{ a.symbol }}
          </button>
        </div>
      </div>

      <button
        class="btn btn-primary"
        type="button"
        style="width: 100%"
        :disabled="selectedIds.length === 0 || initialUsd < 100"
        @click="demo.start(initialUsd, selectedIds, engineMode)"
      >
        ▶ デモトレードを開始
      </button>
    </section>

    <!-- 実行中/停止中ダッシュボード -->
    <template v-else>
      <section class="card">
        <div class="stats-grid">
          <div>
            <div class="xs faint">総資産</div>
            <div class="mono bold" style="font-size: 1.2rem">{{ fmtUsd(demo.equityUsd) }}</div>
          </div>
          <div v-if="demo.summary">
            <div class="xs faint">損益</div>
            <div class="mono bold" :class="demo.summary.totalPnlUsd >= 0 ? 'up' : 'down'">
              {{ fmtUsd(demo.summary.totalPnlUsd) }}（{{ fmtPct(demo.summary.totalPnlPct) }}）
            </div>
          </div>
          <div v-if="demo.summary">
            <div class="xs faint">勝率</div>
            <div class="mono">{{ demo.summary.winRatePct.toFixed(0) }}%（{{ demo.summary.winCount }}勝{{ demo.summary.lossCount }}敗）</div>
          </div>
          <div v-if="demo.summary">
            <div class="xs faint">最大DD</div>
            <div class="mono down">-{{ demo.summary.maxDrawdownPct.toFixed(1) }}%</div>
          </div>
          <div>
            <div class="xs faint">現金</div>
            <div class="mono">{{ fmtUsd(demo.portfolio.cashUsd) }}</div>
          </div>
          <div>
            <div class="xs faint">エンジン</div>
            <div class="small">{{ demo.engineMode === 'ai' ? 'AI (Vertex)' : 'ロジック' }} / {{ strategy.activeDoc.name }}</div>
          </div>
        </div>
        <PriceChart v-if="equityValues.length >= 2" :values="equityValues" color="#22c58b" />
        <div class="controls">
          <button v-if="demo.running" class="btn" type="button" @click="demo.stop()">⏸ 一時停止</button>
          <button v-else class="btn btn-success" type="button" @click="demo.startTicking()">▶ 再開</button>
          <button class="btn btn-danger" type="button" @click="demo.endSession()">■ セッション終了</button>
        </div>
      </section>

      <!-- 保有ポジション -->
      <section class="card">
        <h2>保有ポジション</h2>
        <p v-if="positionRows.length === 0" class="dim small">現在ポジションはありません（現金 100%）</p>
        <div v-for="p in positionRows" :key="p.assetId" class="pos-row">
          <span class="bold">{{ p.symbol }}</span>
          <span class="mono small">{{ fmtQty(p.quantity) }}</span>
          <span class="mono small dim">@{{ fmtUsd(p.avgCostUsd) }}</span>
          <span class="mono small">{{ fmtUsd(p.valueUsd) }}</span>
          <span class="mono small" :class="p.pnlPct >= 0 ? 'up' : 'down'">{{ fmtPct(p.pnlPct) }}</span>
        </div>
      </section>

      <!-- 注文履歴（判断理由付き: BR-4） -->
      <section class="card">
        <div class="card-title">
          <h2>注文履歴</h2>
          <span class="xs faint">{{ demo.portfolio.orders.length }} 件（各注文に AI の判断理由付き）</span>
        </div>
        <OrderList :orders="demo.portfolio.orders" />
      </section>
    </template>

    <!-- 過去セッションのアーカイブ（記録は巻き戻さない: BR-7） -->
    <section v-if="demo.archives.length > 0" class="card">
      <h2>過去セッション</h2>
      <div v-for="(a, i) in demo.archives" :key="i" class="archive-row small">
        <span class="xs faint nowrap">{{ fmtTime(a.endedAt) }}</span>
        <span>{{ a.strategyName }}</span>
        <span class="dim xs">{{ a.assetIds.map((id) => ASSET_MAP[id]?.symbol ?? id).join(' ') }}</span>
        <span class="mono" :class="a.summary.totalPnlUsd >= 0 ? 'up' : 'down'">
          {{ fmtPct(a.summary.totalPnlPct) }}
        </span>
        <span class="mono xs dim">{{ a.summary.tradeCount }}回 勝率{{ a.summary.winRatePct.toFixed(0) }}%</span>
      </div>
    </section>
  </div>
</template>

<style scoped>
.stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 12px; }
@media (min-width: 768px) { .stats-grid { grid-template-columns: repeat(6, 1fr); } }
.controls { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
.asset-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip {
  padding: 7px 12px;
  border-radius: 99px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text-dim);
  font-weight: 700;
  font-size: 0.8rem;
  cursor: pointer;
  min-height: 34px;
}
.chip.on { background: var(--accent-soft); border-color: var(--accent); color: var(--accent); }
.rec-box {
  background: var(--accent-soft);
  border-radius: var(--radius-sm);
  padding: 8px 12px;
  margin-bottom: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pos-row, .archive-row {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 7px 0;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.pos-row:last-child, .archive-row:last-child { border-bottom: none; }
.pos-row span:last-child { margin-left: auto; }
</style>

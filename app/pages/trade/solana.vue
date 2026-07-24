<script setup lang="ts">
import { fmtAgo, fmtPct, fmtUsd } from '~/shared/format'
import { useSolanaStore, type DegenMethod } from '~/stores/solana'
import { useStrategyStore } from '~/stores/strategy'

// Solana 魔界トレード（UC-5 / F-05, F-06）
const solana = useSolanaStore()
const strategy = useStrategyStore()

const allocatedUsd = ref(1_000)
const method = ref<DegenMethod>('ladder')
const selectedPairs = ref<string[]>([])

function togglePair(addr: string) {
  selectedPairs.value = selectedPairs.value.includes(addr)
    ? selectedPairs.value.filter((v) => v !== addr)
    : [...selectedPairs.value, addr]
}

function applyRecommendation() {
  selectedPairs.value = solana.recommended.slice(0, 3).map((s) => s.token.pairAddress)
}

const equityValues = computed(() => solana.portfolio?.equityCurve.map((p) => p.equityUsd) ?? [])
const positionRows = computed(() => {
  return (solana.portfolio?.positions ?? []).map((p) => {
    const token = solana.tokenOf(p.assetId)
    const price = token?.priceUsd ?? p.avgCostUsd
    const pnlPct = p.avgCostUsd > 0 ? ((price - p.avgCostUsd) / p.avgCostUsd) * 100 : 0
    const meta = solana.positionMeta[p.assetId]
    return {
      pairAddress: p.assetId,
      symbol: token?.baseSymbol ?? p.assetId.slice(0, 6),
      quantity: p.quantity,
      valueUsd: p.quantity * price,
      pnlPct,
      triggeredCount: meta?.triggered.length ?? 0,
    }
  })
})

onMounted(async () => {
  await strategy.restoreState()
  await solana.restoreState()
  await solana.fetchTokens()
})
onBeforeUnmount(() => {
  // 画面を離れてもセッション自体は継続（stop はユーザー操作でのみ）
})
useHead({ title: 'Solana魔界 | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1>🌊 Solana 魔界トレード</h1>
      <span v-if="solana.running" class="badge badge-up">● 実行中</span>
    </div>
    <div class="disclaimer" role="note">
      ⚠️ 対象は流動性の低い超高リスクトークンです。取引はデモ資金で実行されます（実資金の取引は
      <NuxtLink to="/trade/live">実トレード</NuxtLink> から）。
    </div>
    <div v-if="solana.usingMockData" class="disclaimer" role="alert">
      ⚠️ DexScreener に接続できないため参考データ（モック）を表示しています。
    </div>

    <!-- セッション設定 -->
    <section v-if="!solana.portfolio" class="card">
      <h2>自動取引セッションを開始</h2>
      <label class="field">
        <span>割当資金（USD・デモ）</span>
        <input v-model.number="allocatedUsd" type="number" class="input" min="100" step="100" inputmode="numeric" />
      </label>
      <div class="field">
        <span class="small dim">取引手法</span>
        <div class="tabs" style="max-width: 480px">
          <button class="tab" :class="{ active: method === 'ladder' }" type="button" @click="method = 'ladder'">
            ラダーロジック（+100%で50%利確）
          </button>
          <button class="tab" :class="{ active: method === 'ai' }" type="button" @click="method = 'ai'">
            AI 取引
          </button>
        </div>
        <p class="xs dim" style="margin-top: 6px">
          <template v-if="method === 'ladder'">
            開始時に選択トークンへ等分エントリーし、+100% で 50% 利確 / +300% でさらに 50% 利確 / -30% で全損切りを機械的に実行します。
          </template>
          <template v-else>
            ティックごとに AI（Vertex AI、未接続時はロジック）がスコア・戦略「{{ strategy.activeDoc.name }}」に基づいて売買を判断します。
          </template>
        </p>
      </div>
      <div class="field">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
          <span class="small dim">対象トークン（{{ selectedPairs.length }} 選択中）</span>
          <button class="btn btn-sm" type="button" :disabled="solana.recommended.length === 0" @click="applyRecommendation">
            🤖 AI のおすすめを使う
          </button>
        </div>
      </div>
      <button
        class="btn btn-primary"
        style="width: 100%"
        type="button"
        :disabled="selectedPairs.length === 0 || allocatedUsd < 100"
        @click="solana.start(allocatedUsd, selectedPairs, method)"
      >
        ▶ 魔界トレードを開始
      </button>
    </section>

    <!-- 実行中ダッシュボード -->
    <section v-else class="card">
      <div class="stats-grid">
        <div>
          <div class="xs faint">評価額</div>
          <div class="mono bold" style="font-size: 1.15rem">
            {{ fmtUsd(solana.summary?.equityUsd ?? 0) }}
          </div>
        </div>
        <div v-if="solana.summary">
          <div class="xs faint">損益</div>
          <div class="mono bold" :class="solana.summary.totalPnlUsd >= 0 ? 'up' : 'down'">
            {{ fmtPct(solana.summary.totalPnlPct) }}
          </div>
        </div>
        <div>
          <div class="xs faint">手法</div>
          <div class="small">{{ solana.method === 'ladder' ? 'ラダー' : 'AI 取引' }}</div>
        </div>
        <div v-if="solana.summary">
          <div class="xs faint">取引数</div>
          <div class="mono">{{ solana.summary.tradeCount }}</div>
        </div>
      </div>
      <PriceChart v-if="equityValues.length >= 2" :values="equityValues" color="#14f195" />

      <h3 style="margin-top: 12px">保有ポジション</h3>
      <p v-if="positionRows.length === 0" class="dim small">ポジションなし</p>
      <div v-for="p in positionRows" :key="p.pairAddress" class="pos-row small">
        <span class="bold">{{ p.symbol }}</span>
        <span class="mono">{{ fmtUsd(p.valueUsd) }}</span>
        <span class="mono" :class="p.pnlPct >= 0 ? 'up' : 'down'">{{ fmtPct(p.pnlPct) }}</span>
        <span v-if="solana.method === 'ladder'" class="xs faint">ラダー発動 {{ p.triggeredCount }}/{{ solana.ladderRules.length }}</span>
      </div>

      <div class="controls">
        <button v-if="solana.running" class="btn" type="button" @click="solana.stop()">⏸ 一時停止</button>
        <button v-else class="btn btn-success" type="button" @click="solana.startTicking()">▶ 再開</button>
        <button class="btn btn-danger" type="button" @click="solana.endSession()">■ セッション終了</button>
      </div>

      <h3 style="margin-top: 14px">約定・イベント履歴</h3>
      <OrderList :orders="solana.portfolio.orders" />
    </section>

    <!-- 過去セッション -->
    <section v-if="solana.archives.length > 0" class="card">
      <h2>過去セッション</h2>
      <div v-for="(a, i) in solana.archives" :key="i" class="pos-row small">
        <span class="xs faint">{{ fmtAgo(a.endedAt) }}</span>
        <span>{{ a.method === 'ladder' ? 'ラダー' : 'AI' }}</span>
        <span class="dim xs">{{ a.tokenSymbols.join(' ') }}</span>
        <span class="mono" :class="a.summary.totalPnlUsd >= 0 ? 'up' : 'down'">{{ fmtPct(a.summary.totalPnlPct) }}</span>
      </div>
    </section>

    <!-- スクリーニングリスト -->
    <section style="margin-top: 16px">
      <div class="card-title">
        <h2>トークンスクリーニング</h2>
        <span class="xs faint" v-if="solana.lastFetchedAt">更新: {{ fmtAgo(solana.lastFetchedAt) }}</span>
      </div>
      <p class="xs dim">
        スコア = 流動性 35% + 出来高 25% + モメンタム 20% + 成熟度 20%。スコアは選定支援であり利益を保証しません。
      </p>
      <div v-if="solana.loading && solana.tokens.length === 0" class="grid grid-2">
        <div v-for="i in 4" :key="i" class="skeleton" style="height: 120px" />
      </div>
      <div v-else class="grid grid-2">
        <TokenScoreCard
          v-for="s in solana.ranked.slice(0, 20)"
          :key="s.token.pairAddress"
          :score="s"
          :selected="selectedPairs.includes(s.token.pairAddress)"
          @select="togglePair"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 12px; }
@media (min-width: 768px) { .stats-grid { grid-template-columns: repeat(4, 1fr); } }
.controls { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.pos-row { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.pos-row:last-child { border-bottom: none; }
</style>

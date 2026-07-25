<script setup lang="ts">
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Pause,
  Play,
  RefreshCw,
  Rocket,
  Square,
  TriangleAlert,
  Waves,
} from '@lucide/vue'
import { fmtAgo, fmtPct, fmtUsd } from '~/shared/format'
import {
  DEGEN_METHOD_LABELS,
  DISPLAY_REFRESH_MS,
  useSolanaStore,
  type DegenMethod,
} from '~/stores/solana'
import { useStrategyStore } from '~/stores/strategy'

// Solana 魔界トレード（UC-5 / F-05, F-06）
const solana = useSolanaStore()
const strategy = useStrategyStore()

const allocatedUsd = ref(1_000)
const method = ref<DegenMethod>('ladder')
const selectedPairs = ref<string[]>([])
/** 展開中の過去セッション（約定履歴の閲覧: F-05） */
const expandedArchive = ref<number | null>(null)

function togglePair(addr: string) {
  selectedPairs.value = selectedPairs.value.includes(addr)
    ? selectedPairs.value.filter((v) => v !== addr)
    : [...selectedPairs.value, addr]
}

function applyRecommendation() {
  selectedPairs.value =
    method.value === 'snipe'
      ? solana.freshRecommended.map((s) => s.token.pairAddress)
      : solana.recommended.slice(0, 3).map((s) => s.token.pairAddress)
}

// スナイプは新規上場リスト・他手法はスクリーニングリストから選ぶため、切替時に選択をリセット
watch(method, (m, prev) => {
  if ((m === 'snipe') !== (prev === 'snipe')) selectedPairs.value = []
  if (m === 'snipe') void solana.fetchFreshTokens()
})

/** 開始後はダッシュボード（ページ上部に描画）へ視点を移動する */
async function startSession() {
  await solana.start(allocatedUsd.value, selectedPairs.value, method.value)
  if (solana.portfolio) window.scrollTo({ top: 0, behavior: 'smooth' })
}

/** セッション終了の誤タップ防止 */
function confirmEndSession() {
  if (window.confirm('魔界トレードのセッションを終了しますか？\n実行中の自動取引が停止し、結果は過去セッション（約定履歴つき）に保存されます。')) {
    solana.endSession()
    expandedArchive.value = null
  }
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

/** アーカイブの約定履歴で使うシンボル解決（保存済み対応表 → 現在のトークンリスト） */
function archiveSymbolResolver(archiveIndex: number) {
  return (assetId: string): string | undefined =>
    solana.archives[archiveIndex]?.symbols?.[assetId] ?? solana.tokenOf(assetId)?.baseSymbol
}

function toggleArchive(i: number) {
  expandedArchive.value = expandedArchive.value === i ? null : i
}

// 表示価格の定期更新（一時停止中・復元直後でも損益をリアルタイムに保つ: F-05）
let displayTimer: ReturnType<typeof setInterval> | null = null
function refreshDisplay() {
  if (document.visibilityState === 'visible') void solana.refreshDisplayPrices()
}

onMounted(async () => {
  displayTimer = setInterval(refreshDisplay, DISPLAY_REFRESH_MS)
  document.addEventListener('visibilitychange', refreshDisplay)
  await strategy.restoreState()
  await solana.restoreState()
  await solana.fetchTokens()
  void solana.refreshDisplayPrices()
})
onBeforeUnmount(() => {
  // 画面を離れてもセッション自体は継続（stop はユーザー操作でのみ）
  if (displayTimer) clearInterval(displayTimer)
  document.removeEventListener('visibilitychange', refreshDisplay)
})
useHead({ title: 'Solana魔界 | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1><Waves :size="20" class="icon-inline" aria-hidden="true" />Solana 魔界トレード</h1>
      <span v-if="solana.running" class="badge badge-up">実行中</span>
    </div>
    <div class="disclaimer" role="note">
      <TriangleAlert :size="14" class="icon-inline" aria-hidden="true" />
      対象は流動性の低い超高リスクトークンです。取引はデモ資金で実行されます（実資金の取引は
      <NuxtLink to="/trade/live">実トレード</NuxtLink> から）。
    </div>
    <div v-if="solana.usingMockData" class="disclaimer" role="alert">
      <TriangleAlert :size="14" class="icon-inline" aria-hidden="true" />
      DexScreener に接続できないため参考データ（モック）を表示しています。価格・損益は更新されません。
      <span v-if="solana.lastError" class="xs faint">（CRYPTIA-E102: {{ solana.lastError }}）</span>
      <button class="btn btn-sm" type="button" style="margin-left: 8px" :disabled="solana.loading" @click="solana.fetchTokens(true)">
        <RefreshCw :size="13" aria-hidden="true" /> {{ solana.loading ? '再接続中…' : '再試行' }}
      </button>
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
        <div class="tabs" style="max-width: 560px">
          <button class="tab" :class="{ active: method === 'ladder' }" type="button" @click="method = 'ladder'">
            ラダーロジック
          </button>
          <button class="tab" :class="{ active: method === 'snipe' }" type="button" @click="method = 'snipe'">
            <Rocket :size="13" aria-hidden="true" /> 新規上場ハンター
          </button>
          <button class="tab" :class="{ active: method === 'ai' }" type="button" @click="method = 'ai'">
            AI 取引
          </button>
        </div>
        <p class="xs dim" style="margin-top: 6px">
          <template v-if="method === 'ladder'">
            開始時に選択トークンへ等分エントリーし、+100% で 50% 利確 / +300% でさらに 50% 利確 / -30% で全損切りを機械的に実行します。
          </template>
          <template v-else-if="method === 'snipe'">
            発行 48 時間以内の新規上場トークンを、dev 情報（mint/freeze 権限）・SNS の有無・初期流動性・同一 dev の再発行チェックで選定。
            +50% で 30% 利確（早期に元本回収）→ +100% で 30% → +300% で 20% と利益を確保しながら残り 20% で大きな伸びを狙い、-40% で全損切りします。
          </template>
          <template v-else>
            ティックごとに AI（Vertex AI、未接続時はロジック）がスコア・戦略「{{ strategy.docFor('solana').name }}」に基づいて売買を判断します。
          </template>
        </p>
      </div>
      <div class="field">
        <StrategyPicker context="solana" />
      </div>
      <div class="field">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
          <span class="small dim">対象トークン（{{ selectedPairs.length }} 選択中）</span>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="method === 'snipe' ? solana.freshRecommended.length === 0 : solana.recommended.length === 0"
            @click="applyRecommendation"
          >
            <Bot :size="14" aria-hidden="true" /> AI のおすすめを使う
          </button>
        </div>

        <!-- スナイプ: 新規上場（48h以内）トークンから選択 -->
        <template v-if="method === 'snipe'">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
            <span class="xs faint">
              新規上場トークン {{ solana.freshTokens.length }} 件
              <template v-if="solana.freshFetchedAt">（更新: {{ fmtAgo(solana.freshFetchedAt) }}）</template>
            </span>
            <button class="btn btn-sm" type="button" :disabled="solana.freshLoading" @click="solana.fetchFreshTokens(true)">
              <RefreshCw :size="13" aria-hidden="true" /> {{ solana.freshLoading ? '取得中…' : '更新' }}
            </button>
          </div>
          <div v-if="solana.freshLoading && solana.freshTokens.length === 0" class="grid grid-2">
            <div v-for="i in 4" :key="i" class="skeleton" style="height: 110px" />
          </div>
          <p v-else-if="solana.freshTokens.length === 0 && solana.freshError" class="small" style="color: var(--warn)">
            <TriangleAlert :size="13" class="icon-inline" aria-hidden="true" />
            新規上場リストを取得できませんでした（CRYPTIA-E102: {{ solana.freshError }}）。「更新」で再試行してください。
          </p>
          <p v-else-if="solana.freshTokens.length === 0" class="dim small">
            現在、条件に合う新規上場トークンが見つかりません（発行 48 時間以内・流動性あり）。しばらくして「更新」を押してください。
          </p>
          <div v-else class="grid grid-2">
            <SnipeTokenCard
              v-for="s in solana.freshTokens"
              :key="s.token.pairAddress"
              :score="s"
              :selected="selectedPairs.includes(s.token.pairAddress)"
              @select="togglePair"
            />
          </div>
          <p class="xs faint" style="margin-top: 6px">
            シグナル（mint 権限・再発行照合等）は取得できた公開情報に基づく選定支援であり、安全性や利益を保証しません。
          </p>
        </template>
        <p v-else class="xs faint">下部の「トークンスクリーニング」からカードをタップして選択します。</p>
      </div>
      <button
        class="btn btn-primary"
        style="width: 100%"
        type="button"
        :disabled="selectedPairs.length === 0 || allocatedUsd < 100"
        @click="startSession"
      >
        <Play :size="15" aria-hidden="true" /> 魔界トレードを開始
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
          <div class="small">{{ DEGEN_METHOD_LABELS[solana.method] }}</div>
        </div>
        <div v-if="solana.summary">
          <div class="xs faint">取引数</div>
          <div class="mono">{{ solana.summary.tradeCount }}</div>
        </div>
      </div>
      <p class="xs faint" style="margin: 0 0 8px">
        <template v-if="solana.usingMockData">参考データ表示中のため価格は更新されません</template>
        <template v-else-if="solana.lastPricesAt">
          価格更新: {{ fmtAgo(solana.lastPricesAt) }}（{{ solana.running ? '自動売買 実行中' : '一時停止中も約10秒ごとに更新' }}）
        </template>
      </p>
      <PriceChart v-if="equityValues.length >= 2" :values="equityValues" color="#14f195" />

      <h3 style="margin-top: 12px">保有ポジション</h3>
      <p v-if="positionRows.length === 0" class="dim small">ポジションなし</p>
      <div v-for="p in positionRows" :key="p.pairAddress" class="pos-row small">
        <span class="bold">{{ p.symbol }}</span>
        <span class="mono">{{ fmtUsd(p.valueUsd) }}</span>
        <span class="mono" :class="p.pnlPct >= 0 ? 'up' : 'down'">{{ fmtPct(p.pnlPct) }}</span>
        <span v-if="solana.method !== 'ai'" class="xs faint">ラダー発動 {{ p.triggeredCount }}/{{ solana.ladderRules.length }}</span>
      </div>

      <div class="controls">
        <button v-if="solana.running" class="btn" type="button" @click="solana.stop()">
          <Pause :size="15" aria-hidden="true" /> 一時停止
        </button>
        <button v-else class="btn btn-success" type="button" @click="solana.startTicking()">
          <Play :size="15" aria-hidden="true" /> 再開
        </button>
        <button class="btn btn-danger" type="button" @click="confirmEndSession">
          <Square :size="14" aria-hidden="true" /> セッション終了
        </button>
      </div>

      <h3 style="margin-top: 14px">約定・イベント履歴</h3>
      <OrderList
        :orders="solana.portfolio.orders"
        :symbol-resolver="(addr) => solana.tokenOf(addr)?.baseSymbol"
      />
    </section>

    <!-- 過去セッション（タップで約定履歴を展開: F-05） -->
    <section v-if="solana.archives.length > 0" class="card">
      <h2>過去セッション</h2>
      <p class="xs faint">行をタップすると、そのセッションの約定履歴を表示します。</p>
      <div v-for="(a, i) in solana.archives" :key="a.endedAt">
        <button
          class="archive-row small"
          type="button"
          :aria-expanded="expandedArchive === i"
          @click="toggleArchive(i)"
        >
          <span class="xs faint nowrap">{{ fmtAgo(a.endedAt) }}</span>
          <span>{{ DEGEN_METHOD_LABELS[a.method] ?? a.method }}</span>
          <span class="dim xs symbols">{{ a.tokenSymbols.join(' ') }}</span>
          <span class="mono" :class="a.summary.totalPnlUsd >= 0 ? 'up' : 'down'">{{ fmtPct(a.summary.totalPnlPct) }}</span>
          <span class="mono xs dim">{{ a.summary.tradeCount }}回</span>
          <component :is="expandedArchive === i ? ChevronUp : ChevronDown" :size="15" class="dim" aria-hidden="true" />
        </button>
        <div v-if="expandedArchive === i" class="archive-detail">
          <OrderList
            v-if="a.orders && a.orders.length > 0"
            :orders="a.orders"
            :limit="100"
            :symbol-resolver="archiveSymbolResolver(i)"
          />
          <p v-else class="dim small" style="padding: 8px 0">
            このセッションの約定明細は保存されていません（履歴保存機能の追加前、または容量保護で明細を省略した古い記録です。サマリーのみ閲覧できます）。
          </p>
        </div>
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
.archive-row {
  display: flex;
  gap: 10px;
  align-items: center;
  width: 100%;
  padding: 8px 0;
  border: none;
  border-bottom: 1px solid var(--border);
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  flex-wrap: wrap;
}
.archive-row .symbols { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 60px; }
.archive-detail {
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 6px 0 10px;
}
</style>

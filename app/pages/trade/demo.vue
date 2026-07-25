<script setup lang="ts">
import { Bot, ChevronDown, ChevronUp, FlaskConical, Pause, Play, Square } from '@lucide/vue'
import { ASSET_MAP, ASSETS } from '~/shared/assets'
import { fmtAgo, fmtPct, fmtQty, fmtTime, fmtUsd } from '~/shared/format'
import { MAX_DEMO_SESSIONS, useDemoTradeStore, type EngineMode } from '~/stores/demoTrade'
import { useMarketStore } from '~/stores/market'
import { useStrategyStore } from '~/stores/strategy'

// AI デモトレード（UC-4 / F-04）。複数セッションを同時実行できる
const demo = useDemoTradeStore()
const market = useMarketStore()
const strategy = useStrategyStore()

const initialUsd = ref(10_000)
const engineMode = ref<EngineMode>('logic')
const selectedIds = ref<string[]>(['bitcoin', 'ethereum', 'solana'])
const sessionName = ref('')
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

/** 開始が成功したときだけ入力をクリアする（上限到達等の失敗時は入力を保持して再試行しやすくする） */
function startSession() {
  const before = demo.sessions.length
  demo.start(initialUsd.value, selectedIds.value, engineMode.value, sessionName.value)
  if (demo.sessions.length > before) {
    sessionName.value = ''
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

/** セッション終了の誤タップ防止（実行中の自動売買が止まりアーカイブへ移るため確認を挟む） */
function confirmEndSession(id: string, name: string) {
  if (window.confirm(`「${name}」を終了しますか？\n実行中の自動売買が停止し、結果は過去セッション（約定履歴つき）に保存されます。`)) {
    demo.endSession(id)
    if (expandedSession.value === id) expandedSession.value = null
    // アーカイブ先頭に新しい行が挿入され、番号ベースの展開状態が別の行を指すため閉じる
    expandedArchive.value = null
  }
}

/** 展開中のセッション詳細（チャート・ポジション・注文履歴。見たいときだけ可視化） */
const expandedSession = ref<string | null>(null)
function toggleSession(id: string) {
  expandedSession.value = expandedSession.value === id ? null : id
}

/** 展開中の過去セッション（約定履歴の閲覧: F-04） */
const expandedArchive = ref<number | null>(null)
function toggleArchive(i: number) {
  expandedArchive.value = expandedArchive.value === i ? null : i
}

/** セッションカードの表示値を1回で算出する（テンプレートから同じゲッターを繰り返し呼ばない） */
const sessionRows = computed(() =>
  demo.sessions.map((s) => {
    const prices = market.priceMap
    return {
      s,
      equity: demo.equityOf(s.id),
      summary: demo.summaryOf(s.id),
      equityValues: s.portfolio.equityCurve.map((p) => p.equityUsd),
      positions: s.portfolio.positions.map((p) => {
        const price = prices[p.assetId] ?? p.avgCostUsd
        const valueUsd = p.quantity * price
        const pnlPct = p.avgCostUsd > 0 ? ((price - p.avgCostUsd) / p.avgCostUsd) * 100 : 0
        return { ...p, price, valueUsd, pnlPct, symbol: ASSET_MAP[p.assetId]?.symbol ?? p.assetId }
      }),
    }
  }),
)

onMounted(async () => {
  await strategy.restoreState()
  await demo.restoreState()
})
useHead({ title: 'デモトレード | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1><FlaskConical :size="20" class="icon-inline" aria-hidden="true" />AI デモトレード</h1>
      <span v-if="demo.anyRunning" class="badge badge-up">自動売買 実行中</span>
    </div>

    <!-- 実行中セッション一覧（複数同時実行可能） -->
    <section v-for="{ s, equity, summary, equityValues, positions } in sessionRows" :key="s.id" class="card session-card">
      <div class="card-title">
        <h2>
          {{ s.name }}
          <span class="badge" :class="s.running ? 'badge-up' : 'badge-warn'">
            {{ s.running ? '実行中' : '一時停止' }}
          </span>
          <span v-if="s.engineMode === 'ai' && s.aiDegradedAt" class="badge badge-warn" title="AI 判断 API が混雑しています。ロジックエンジンで取引を継続中です">
            AI混雑: ロジックで継続中
          </span>
        </h2>
        <span class="xs faint">{{ s.engineMode === 'ai' ? 'AI (Vertex)' : 'ロジック' }} / {{ s.assetIds.map((id) => ASSET_MAP[id]?.symbol ?? id).join(' ') }}</span>
      </div>
      <div class="stats-grid">
        <div>
          <div class="xs faint">総資産</div>
          <div class="mono bold" style="font-size: 1.1rem">{{ fmtUsd(equity) }}</div>
        </div>
        <div v-if="summary">
          <div class="xs faint">損益</div>
          <div class="mono bold" :class="summary.totalPnlUsd >= 0 ? 'up' : 'down'">
            {{ fmtUsd(summary.totalPnlUsd) }}（{{ fmtPct(summary.totalPnlPct) }}）
          </div>
        </div>
        <div v-if="summary">
          <div class="xs faint">勝率</div>
          <div class="mono">{{ summary.winRatePct.toFixed(0) }}%（{{ summary.winCount }}勝{{ summary.lossCount }}敗）</div>
        </div>
        <div>
          <div class="xs faint">現金</div>
          <div class="mono">{{ fmtUsd(s.portfolio.cashUsd) }}</div>
        </div>
      </div>
      <p class="xs faint" style="margin: 0 0 8px">
        <span v-if="market.streaming" class="badge badge-up" style="margin-right: 6px">価格 LIVE</span>
        <template v-if="market.usingMockData">価格 API に接続できないため参考データ表示中（損益は更新されません）</template>
        <template v-else-if="market.lastUpdatedAt">価格更新: {{ fmtAgo(market.lastUpdatedAt) }}（損益はリアルタイム反映）</template>
      </p>
      <div class="controls">
        <button v-if="s.running" class="btn btn-sm" type="button" @click="demo.pause(s.id)">
          <Pause :size="14" aria-hidden="true" /> 一時停止
        </button>
        <button v-else class="btn btn-sm btn-success" type="button" @click="demo.resume(s.id)">
          <Play :size="14" aria-hidden="true" /> 再開
        </button>
        <button class="btn btn-sm btn-danger" type="button" @click="confirmEndSession(s.id, s.name)">
          <Square :size="13" aria-hidden="true" /> セッション終了
        </button>
        <button
          class="btn btn-sm btn-ghost"
          type="button"
          :aria-expanded="expandedSession === s.id"
          @click="toggleSession(s.id)"
        >
          <component :is="expandedSession === s.id ? ChevronUp : ChevronDown" :size="14" aria-hidden="true" />
          {{ expandedSession === s.id ? '詳細を閉じる' : '詳細（ポジション・注文履歴）' }}
        </button>
      </div>

      <!-- 詳細（見たいときだけ展開） -->
      <template v-if="expandedSession === s.id">
        <PriceChart v-if="equityValues.length >= 2" :values="equityValues" color="#22c58b" />

        <h3 style="margin-top: 10px">保有ポジション</h3>
        <p v-if="positions.length === 0" class="dim small">現在ポジションはありません（現金 100%）</p>
        <div v-for="p in positions" :key="p.assetId" class="pos-row">
          <span class="bold">{{ p.symbol }}</span>
          <span class="mono small">{{ fmtQty(p.quantity) }}</span>
          <span class="mono small dim">@{{ fmtUsd(p.avgCostUsd) }}</span>
          <span class="mono small">{{ fmtUsd(p.valueUsd) }}</span>
          <span class="mono small" :class="p.pnlPct >= 0 ? 'up' : 'down'">{{ fmtPct(p.pnlPct) }}</span>
        </div>

        <div class="card-title" style="margin-top: 10px">
          <h3>注文履歴</h3>
          <span class="xs faint">{{ s.portfolio.orders.length }} 件（各注文に AI の判断理由付き）</span>
        </div>
        <OrderList :orders="s.portfolio.orders" />
      </template>
    </section>

    <!-- 新規セッション開始フォーム（既存セッションを動かしたまま追加できる） -->
    <section class="card">
      <div class="card-title">
        <h2>新しいセッションを開始</h2>
        <span class="xs faint">{{ demo.sessions.length }} / {{ MAX_DEMO_SESSIONS }} セッション</span>
      </div>
      <div class="grid grid-2">
        <label class="field">
          <span>初期資金（USD）</span>
          <input v-model.number="initialUsd" type="number" class="input" min="100" step="100" inputmode="numeric" />
        </label>
        <label class="field">
          <span>セッション名（任意）</span>
          <input v-model="sessionName" class="input" maxlength="30" placeholder="例: BTC強気シナリオ" />
        </label>
      </div>

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
        <StrategyPicker context="demo" />
      </div>

      <div class="field">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
          <span class="small dim">取引対象銘柄（{{ selectedIds.length }} 選択中）</span>
          <button class="btn btn-sm" type="button" @click="applyRecommendation">
            <Bot :size="14" aria-hidden="true" /> AI のおすすめを使う
          </button>
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
            :aria-pressed="selectedIds.includes(a.id)"
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
        :disabled="selectedIds.length === 0 || initialUsd < 100 || demo.sessions.length >= MAX_DEMO_SESSIONS"
        @click="startSession"
      >
        <Play :size="15" aria-hidden="true" /> デモトレードを開始
      </button>
      <p v-if="demo.sessions.length >= MAX_DEMO_SESSIONS" class="xs warn" style="margin-top: 6px">
        同時実行の上限（{{ MAX_DEMO_SESSIONS }} 件）に達しています。不要なセッションを終了すると新規開始できます。
      </p>
    </section>

    <!-- 過去セッションのアーカイブ（記録は巻き戻さない: BR-7。タップで約定履歴を展開: F-04） -->
    <section v-if="demo.archives.length > 0" class="card">
      <h2>過去セッション</h2>
      <p class="xs faint">行をタップすると、そのセッションの約定履歴を表示します。</p>
      <div v-for="(a, i) in demo.archives" :key="a.endedAt">
        <button
          class="archive-row small"
          type="button"
          :aria-expanded="expandedArchive === i"
          @click="toggleArchive(i)"
        >
          <span class="xs faint nowrap">{{ fmtTime(a.endedAt) }}</span>
          <span>{{ a.name ?? a.strategyName }}</span>
          <span class="dim xs symbols">{{ a.assetIds.map((id) => ASSET_MAP[id]?.symbol ?? id).join(' ') }}</span>
          <span class="mono" :class="a.summary.totalPnlUsd >= 0 ? 'up' : 'down'">
            {{ fmtPct(a.summary.totalPnlPct) }}
          </span>
          <span class="mono xs dim">{{ a.summary.tradeCount }}回 勝率{{ a.summary.winRatePct.toFixed(0) }}%</span>
          <component :is="expandedArchive === i ? ChevronUp : ChevronDown" :size="15" class="dim" aria-hidden="true" />
        </button>
        <div v-if="expandedArchive === i" class="archive-detail">
          <OrderList v-if="a.orders && a.orders.length > 0" :orders="a.orders" :limit="100" />
          <p v-else class="dim small" style="padding: 8px 0">
            このセッションの約定明細は保存されていません（履歴保存機能の追加前、または容量保護で明細を省略した古い記録です。サマリーのみ閲覧できます）。
          </p>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.session-card { border-left: 3px solid var(--accent); }
.stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 10px; }
@media (min-width: 768px) { .stats-grid { grid-template-columns: repeat(4, 1fr); } }
.controls { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; }
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
.warn { color: var(--warn); }
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
.pos-row:last-child { border-bottom: none; }
.pos-row span:last-child { margin-left: auto; }
.archive-row {
  width: 100%;
  border-top: none;
  border-left: none;
  border-right: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  padding: 8px 0;
  font-family: inherit;
  line-height: inherit;
}
.archive-row .symbols { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 60px; }
.archive-detail {
  background: var(--bg);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin: 6px 0 10px;
}
</style>

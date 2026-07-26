<script setup lang="ts">
import {
  Bot,
  ChevronDown,
  ChevronUp,
  Moon,
  Zap,
  Pause,
  Play,
  Radar,
  RefreshCw,
  Rocket,
  Square,
  TriangleAlert,
  Waves,
} from '@lucide/vue'
import { fmtAgo, fmtPct, fmtUsd } from '~/shared/format'
import {
  MOONBAG_DEFAULT_STOP_LOSS_PCT,
  SCALP_DEFAULT_MAX_AGE_MIN,
  SCALP_DEFAULT_MAX_HOLD_MIN,
  SCALP_DEFAULT_STOP_PCT,
  SCALP_DEFAULT_TARGET_PCT,
} from '~/shared/snipeScoring'
import {
  DEGEN_METHOD_LABELS,
  DISPLAY_REFRESH_MS,
  MAX_DEGEN_SESSIONS,
  MAX_PAIRS_PER_SESSION,
  normalizeAutoSnipe,
  usesAutoPipeline,
  useSolanaStore,
  type DegenMethod,
  type DegenSession,
} from '~/stores/solana'
import { useStrategyStore } from '~/stores/strategy'

// Solana 魔界トレード（UC-5 / F-05, F-06）。複数セッションを同時実行できる
const solana = useSolanaStore()
const strategy = useStrategyStore()

const allocatedUsd = ref(1_000)
const method = ref<DegenMethod>('ladder')
const selectedPairs = ref<string[]>([])
const sessionName = ref('')
/** 自動スナイプ / ムーンバッグ共通の常時監視設定（最大同時ポジション数・監査基準） */
const autoMaxPositions = ref(5)
const autoAllowCaution = ref(false)
/** ムーンバッグの損切りライン（+100% 到達前のみ有効。null = 損切りなし・完全放置） */
const moonbagStopLoss = ref<number | null>(MOONBAG_DEFAULT_STOP_LOSS_PCT)
/** スキャルプ設定（発行経過上限・利確ターゲット・損切り・保有時間上限） */
const scalpTarget = ref(SCALP_DEFAULT_TARGET_PCT)
const scalpStop = ref(SCALP_DEFAULT_STOP_PCT)
const scalpMaxAge = ref(SCALP_DEFAULT_MAX_AGE_MIN)
const scalpMaxHold = ref(SCALP_DEFAULT_MAX_HOLD_MIN)
/** 展開中のセッション詳細（約定履歴） */
const expandedSession = ref<string | null>(null)
/** 展開中の保有ポジション（`${sessionId}:${pairAddress}`。見たいときだけ押下で可視化） */
const expandedPosition = ref<string | null>(null)
/** 展開中の過去セッション（約定履歴の閲覧: F-05） */
const expandedArchive = ref<number | null>(null)

/** 新規上場リストを使う手法か（スナイプ / 自動スナイプ / ムーンバッグ / スキャルプ） */
const usesFresh = (m: DegenMethod) => m === 'snipe' || usesAutoPipeline(m)

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

// スナイプ系は新規上場リスト・他手法はスクリーニングリストから選ぶため、切替時に選択をリセット
/** スキャルプ選択前の監査基準（タブを離れたら元へ戻す = 他手法へ設定が残留しない） */
let allowCautionBeforeScalp = false
watch(method, (m, prev) => {
  if (usesFresh(m) !== usesFresh(prev)) selectedPairs.value = []
  if (usesFresh(m)) void solana.fetchFreshTokens()
  // スキャルプは発行直後の銘柄が対象で「候補」判定に届きにくいため、選択中だけ既定を
  // 「要注意まで許容」へ切り替える（select に反映され、手動で戻せる。離脱時は元の値へ復帰）
  if (m === 'scalp' && prev !== 'scalp') {
    allowCautionBeforeScalp = autoAllowCaution.value
    autoAllowCaution.value = true
  } else if (prev === 'scalp' && m !== 'scalp') {
    autoAllowCaution.value = allowCautionBeforeScalp
  }
})

/** 開始後はセッション一覧（ページ上部に描画）へ視点を移動する */
async function startSession() {
  let autoConfig
  if (usesAutoPipeline(method.value)) {
    // 実効値をフォームへ書き戻し、表示と実行のサイレント乖離を防ぐ
    autoConfig = normalizeAutoSnipe({
      maxPositions: autoMaxPositions.value,
      allowCaution: autoAllowCaution.value,
    })
    autoMaxPositions.value = autoConfig.maxPositions
  }
  const before = solana.sessions.length
  await solana.start(
    allocatedUsd.value,
    usesAutoPipeline(method.value) ? [] : selectedPairs.value,
    method.value,
    autoConfig,
    sessionName.value,
    moonbagStopLoss.value,
    method.value === 'scalp'
      ? {
          targetPct: scalpTarget.value,
          stopPct: scalpStop.value,
          maxAgeMin: scalpMaxAge.value,
          maxHoldMin: scalpMaxHold.value,
        }
      : undefined,
  )
  if (solana.sessions.length > before) {
    sessionName.value = ''
    selectedPairs.value = []
    // 実効値（クランプ後）をフォームへ書き戻し、表示と実行のサイレント乖離を防ぐ
    const started = solana.sessions[solana.sessions.length - 1]
    if (started?.scalp) {
      scalpTarget.value = started.scalp.targetPct
      scalpStop.value = started.scalp.stopPct
      scalpMaxAge.value = started.scalp.maxAgeMin
      scalpMaxHold.value = started.scalp.maxHoldMin
    }
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
}

/** セッション終了の誤タップ防止 */
function confirmEndSession(id: string, name: string) {
  if (window.confirm(`「${name}」を終了しますか？\n実行中の自動取引が停止し、結果は過去セッション（約定履歴つき）に保存されます。`)) {
    solana.endSession(id)
    if (expandedSession.value === id) expandedSession.value = null
    if (expandedPosition.value?.startsWith(`${id}:`)) expandedPosition.value = null
    if (solana.archives.length > 0) expandedArchive.value = null
  }
}

function toggleSession(id: string) {
  expandedSession.value = expandedSession.value === id ? null : id
}
function togglePosition(sessionId: string, pairAddress: string) {
  const key = `${sessionId}:${pairAddress}`
  expandedPosition.value = expandedPosition.value === key ? null : key
}
function toggleArchive(i: number) {
  expandedArchive.value = expandedArchive.value === i ? null : i
}

function positionRows(session: DegenSession) {
  return session.portfolio.positions.map((p) => {
    const token = solana.tokenOf(p.assetId)
    const price = token?.priceUsd ?? p.avgCostUsd
    const pnlPct = p.avgCostUsd > 0 ? ((price - p.avgCostUsd) / p.avgCostUsd) * 100 : 0
    const meta = session.positionMeta[p.assetId]
    return {
      pairAddress: p.assetId,
      symbol: token?.baseSymbol ?? p.assetId.slice(0, 6),
      quantity: p.quantity,
      valueUsd: p.quantity * price,
      pnlPct,
      triggeredCount: meta?.triggered.length ?? 0,
      moonbag: meta?.moonbagAt !== undefined,
    }
  })
}

/** セッションカードの表示値を1回で算出する（テンプレートから同じゲッターを繰り返し呼ばない） */
const sessionRows = computed(() =>
  solana.sessions.map((s) => ({
    s,
    summary: solana.summaryOf(s.id),
    equityValues: s.portfolio.equityCurve.map((p) => p.equityUsd),
    positions: positionRows(s),
    moonbagStats: solana.moonbagStatsOf(s.id),
  })),
)

/** アーカイブの約定履歴で使うシンボル解決（保存済み対応表 → 現在のトークンリスト） */
function archiveSymbolResolver(archiveIndex: number) {
  return (assetId: string): string | undefined =>
    solana.archives[archiveIndex]?.symbols?.[assetId] ?? solana.tokenOf(assetId)?.baseSymbol
}

// 全決済で行が消えた展開状態を掃除する（再エントリー時の無操作自動展開を防ぐ）
watch(
  () => solana.sessions.flatMap((s) => s.portfolio.positions.map((p) => `${s.id}:${p.assetId}`)),
  (keys) => {
    if (expandedPosition.value && !keys.includes(expandedPosition.value)) {
      expandedPosition.value = null
    }
  },
)

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
  // 画面を離れてもセッション自体は継続（停止はユーザー操作でのみ）
  if (displayTimer) clearInterval(displayTimer)
  document.removeEventListener('visibilitychange', refreshDisplay)
})
useHead({ title: 'Solana魔界 | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1><Waves :size="20" class="icon-inline" aria-hidden="true" />Solana 魔界トレード</h1>
      <span v-if="solana.anyRunning" class="badge badge-up">実行中</span>
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

    <!-- 実行中セッション一覧（複数同時実行可能） -->
    <section v-for="{ s, summary, equityValues, positions, moonbagStats } in sessionRows" :key="s.id" class="card session-card">
      <div class="card-title">
        <h2>
          {{ s.name }}
          <span class="badge" :class="s.running ? 'badge-up' : 'badge-warn'">
            {{ s.running ? '実行中' : '一時停止' }}
          </span>
          <span v-if="s.method === 'ai' && s.aiDegradedAt" class="badge badge-warn" title="AI 判断 API が混雑しています。ロジックエンジンで取引を継続中です">
            AI混雑: ロジックで継続中
          </span>
        </h2>
        <span class="xs faint">{{ DEGEN_METHOD_LABELS[s.method] ?? s.method }}</span>
      </div>
      <div class="stats-grid">
        <div>
          <div class="xs faint">評価額</div>
          <div class="mono bold" style="font-size: 1.15rem">
            {{ fmtUsd(summary?.equityUsd ?? 0) }}
          </div>
        </div>
        <div v-if="summary">
          <div class="xs faint">損益</div>
          <div class="mono bold" :class="summary.totalPnlUsd >= 0 ? 'up' : 'down'">
            {{ fmtPct(summary.totalPnlPct) }}
          </div>
        </div>
        <div>
          <div class="xs faint">手法</div>
          <div class="small">{{ DEGEN_METHOD_LABELS[s.method] ?? s.method }}</div>
        </div>
        <div v-if="summary">
          <div class="xs faint">取引数</div>
          <div class="mono">{{ summary.tradeCount }}</div>
        </div>
      </div>
      <p class="xs faint" style="margin: 0 0 8px">
        <template v-if="solana.usingMockData">参考データ表示中のため価格は更新されません</template>
        <template v-else-if="solana.lastPricesAt">
          価格更新: {{ fmtAgo(solana.lastPricesAt) }}（{{ s.running ? '自動売買 実行中' : '一時停止中も約10秒ごとに更新' }}）
        </template>
      </p>
      <p v-if="usesAutoPipeline(s.method)" class="xs dim" style="margin: 0 0 8px; display: flex; align-items: center; gap: 5px; flex-wrap: wrap">
        <Radar :size="13" aria-hidden="true" />
        常時監視{{ s.running ? '中' : '（一時停止）' }}:
        新規上場 {{ solana.freshTokens.length }} 件 / 監査通過 {{ solana.freshAuditPassedCount(s.autoSnipe.allowCaution) }} 件 /
        累計エントリー {{ s.enteredMints.length }} 件（最大同時 {{ s.autoSnipe.maxPositions }}・{{ s.autoSnipe.allowCaution ? '要注意まで許容' : '候補のみ' }}）
        <template v-if="solana.freshFetchedAt">・監視更新 {{ fmtAgo(solana.freshFetchedAt) }}</template>
      </p>
      <p v-if="s.scalp" class="xs dim" style="margin: 0 0 8px">
        <Zap :size="12" class="icon-inline" aria-hidden="true" />
        スキャルプ設定: +{{ s.scalp.targetPct }}% で全量利確 / {{ s.scalp.stopPct }}% 損切り /
        発行 {{ s.scalp.maxAgeMin }} 分以内のみ / 保有上限 {{ s.scalp.maxHoldMin }} 分
      </p>
      <p v-if="s.method === 'moonbag'" class="xs moonbag-line" style="margin: 0 0 8px">
        <Moon :size="13" aria-hidden="true" />
        ムーンバッグ保有 {{ moonbagStats.count }} 件（評価額 {{ fmtUsd(moonbagStats.valueUsd) }}・+100% 利確済み・売却ルールなしで保持）
        ・損切り: {{ s.moonbagStopLossPct === null ? 'なし（完全放置）' : `${s.moonbagStopLossPct}%（+100% 到達前のみ）` }}
      </p>

      <h3 style="margin-top: 4px">保有ポジション</h3>
      <p v-if="positions.length === 0" class="dim small">ポジションなし</p>
      <p v-else class="xs faint" style="margin: 0 0 4px">行をタップすると、そのトークンの詳細をその場で表示します。</p>
      <template v-for="p in positions" :key="p.pairAddress">
        <button
          class="pos-row small pos-btn"
          type="button"
          :aria-expanded="expandedPosition === `${s.id}:${p.pairAddress}`"
          @click="togglePosition(s.id, p.pairAddress)"
        >
          <span class="bold">{{ p.symbol }}</span>
          <span class="mono">{{ fmtUsd(p.valueUsd) }}</span>
          <span class="mono" :class="p.pnlPct >= 0 ? 'up' : 'down'">{{ fmtPct(p.pnlPct) }}</span>
          <span v-if="p.moonbag" class="badge badge-moonbag"><Moon :size="10" aria-hidden="true" /> ムーンバッグ保持中</span>
          <span v-else-if="s.method !== 'ai'" class="xs faint">ラダー発動 {{ p.triggeredCount }}/{{ s.ladderRules.length }}</span>
          <component :is="expandedPosition === `${s.id}:${p.pairAddress}` ? ChevronUp : ChevronDown" :size="15" class="dim chev" aria-hidden="true" />
        </button>
        <SolanaPositionDetail
          v-if="expandedPosition === `${s.id}:${p.pairAddress}`"
          :session-id="s.id"
          :pair-address="p.pairAddress"
        />
      </template>

      <div class="controls">
        <button v-if="s.running" class="btn btn-sm" type="button" @click="solana.pause(s.id)">
          <Pause :size="14" aria-hidden="true" /> 一時停止
        </button>
        <button v-else class="btn btn-sm btn-success" type="button" @click="solana.resume(s.id)">
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
          {{ expandedSession === s.id ? '履歴を閉じる' : '約定・イベント履歴' }}
        </button>
      </div>

      <template v-if="expandedSession === s.id">
        <PriceChart v-if="equityValues.length >= 2" :values="equityValues" color="#14f195" />
        <OrderList
          :orders="s.portfolio.orders"
          :symbol-resolver="(addr) => solana.tokenOf(addr)?.baseSymbol"
        />
      </template>
    </section>

    <!-- 新規セッション開始フォーム（既存セッションを動かしたまま追加できる） -->
    <section class="card">
      <div class="card-title">
        <h2>自動取引セッションを開始</h2>
        <span class="xs faint">{{ solana.sessions.length }} / {{ MAX_DEGEN_SESSIONS }} セッション</span>
      </div>
      <div class="grid grid-2">
        <label class="field">
          <span>割当資金（USD・デモ）</span>
          <input v-model.number="allocatedUsd" type="number" class="input" min="100" step="100" inputmode="numeric" />
        </label>
        <label class="field">
          <span>セッション名（任意）</span>
          <input v-model="sessionName" class="input" maxlength="30" placeholder="例: 攻めのスナイプ枠" />
        </label>
      </div>
      <div class="field">
        <span class="small dim">取引手法</span>
        <!-- 5 タブは 375px 幅で画面外に溢れるため折り返す（横スクロール依存の解消: 原則8） -->
        <div class="tabs" style="max-width: 840px; flex-wrap: wrap">
          <button class="tab" :class="{ active: method === 'ladder' }" type="button" @click="method = 'ladder'">
            ラダーロジック
          </button>
          <button class="tab" :class="{ active: method === 'snipe' }" type="button" @click="method = 'snipe'">
            <Rocket :size="13" aria-hidden="true" /> 新規上場ハンター
          </button>
          <button class="tab" :class="{ active: method === 'auto-snipe' }" type="button" @click="method = 'auto-snipe'">
            <Radar :size="13" aria-hidden="true" /> 自動スナイプ
          </button>
          <button class="tab" :class="{ active: method === 'moonbag' }" type="button" @click="method = 'moonbag'">
            <Moon :size="13" aria-hidden="true" /> ムーンバッグ
          </button>
          <button class="tab" :class="{ active: method === 'scalp' }" type="button" @click="method = 'scalp'">
            <Zap :size="13" aria-hidden="true" /> スキャルプ
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
          <template v-else-if="method === 'auto-snipe'">
            <b>トークンの選択は不要です。</b>新規上場トークン（発行 48 時間以内）を常時監視し、最低限の監査を通過したトークンへ
            随時、等分予算で自動エントリーします。出口は新規上場ハンターと同じ利益確保型ラダー
            （+50% で 30% 利確 → +100% で 30% → +300% で 20%、-40% で全損切り）。一度エントリーしたトークンには再エントリーしません。
          </template>
          <template v-else-if="method === 'moonbag'">
            <b>トークンの選択は不要です。</b>自動スナイプと同じ常時監視・監査でエントリーし、出口だけが異なります:
            <b>+100% 到達で 70% を売却</b>（元本の 1.4 倍 = 元本+40% を確定回収）し、
            <b>残り 30% は売却ルールなしのムーンバッグとして保持し続けます</b>（損切りも +100% 到達後は無効）。
            ムーンバッグ化した保有は同時ポジション数に数えないため、新規トークンの監視・エントリーは止まりません。
            注意: +100% に到達しないトークンは損切りだけが出口です（損切りなし設定はほぼ全損リスク）。
          </template>
          <template v-else-if="method === 'scalp'">
            <b>トークンの選択は不要です。</b>監視プールのうち<b>発行直後（既定 5 分以内）に検知できたトークンだけ</b>へエントリーし、
            <b>早い利確ターゲット（既定 +50%）で全量売却</b>して枠を高速に回転させます。損切り（既定 -30%）と
            <b>時間切れ手仕舞い（既定 15 分・どちらにも届かない銘柄を全量手放して次へ）</b>つき。
            一度エントリーしたトークンには再エントリーしません。
            注意: 発行検知は DexScreener フィード経由のため掲載遅延があり、「真の発行 5 分以内」を保証するものではありません。
          </template>
          <template v-else>
            ティックごとに AI（Vertex AI、未接続時はロジック）がスコア・戦略「{{ strategy.docFor('solana').name }}」に基づいて売買を判断します。
          </template>
        </p>
      </div>

      <!-- 自動スナイプ / ムーンバッグ共通の常時監視設定 -->
      <div v-if="usesAutoPipeline(method)" class="field">
        <div class="grid grid-2">
          <label class="field">
            <span>
              最大同時ポジション数（1 枠の予算 = 割当資金 ÷ 本数<template v-if="method === 'moonbag'">。ムーンバッグ化した保有は数えません</template>）
            </span>
            <input v-model.number="autoMaxPositions" type="number" class="input" min="1" max="10" step="1" inputmode="numeric" />
          </label>
          <label class="field">
            <span>監査基準</span>
            <select v-model="autoAllowCaution" class="input">
              <option :value="false">「候補」判定のみ（推奨）</option>
              <option :value="true">{{ method === 'scalp' ? '「要注意」判定まで許容（スキャルプ推奨・自動選択済み）' : '「要注意」判定まで許容（積極的）' }}</option>
            </select>
          </label>
        </div>
        <label v-if="method === 'moonbag'" class="field">
          <span>損切りライン（+100% 到達前のみ有効。到達後は完全放置）</span>
          <select v-model="moonbagStopLoss" class="input">
            <option :value="-50">-50%（推奨）</option>
            <option :value="-30">-30%（早め）</option>
            <option :value="-70">-70%（粘る）</option>
            <option :value="null">なし（完全放置。+100% 未到達のトークンはほぼ全損リスク）</option>
          </select>
        </label>
        <div v-if="method === 'scalp'" class="grid grid-2">
          <label class="field">
            <span>利確ターゲット（到達で全量売却）</span>
            <select v-model.number="scalpTarget" class="input">
              <option :value="50">+50%（既定・回転重視）</option>
              <option :value="70">+70%</option>
              <option :value="100">+100%</option>
              <option :value="30">+30%（最速）</option>
            </select>
          </label>
          <label class="field">
            <span>損切りライン</span>
            <select v-model.number="scalpStop" class="input">
              <option :value="-30">-30%（既定・タイト）</option>
              <option :value="-20">-20%</option>
              <option :value="-50">-50%</option>
            </select>
          </label>
          <label class="field">
            <span>発行からの経過上限（分・これ以内に検知した銘柄のみ買う）</span>
            <input v-model.number="scalpMaxAge" type="number" class="input" min="1" max="30" step="1" inputmode="numeric" />
          </label>
          <label class="field">
            <span>保有時間の上限（分・届かなければ全量手仕舞い）</span>
            <input v-model.number="scalpMaxHold" type="number" class="input" min="3" max="120" step="1" inputmode="numeric" />
          </label>
        </div>
        <p v-if="method === 'moonbag' && moonbagStopLoss === null" class="xs" style="color: var(--warn)">
          <TriangleAlert :size="12" class="icon-inline" aria-hidden="true" />
          損切りなしの損益分岐は「エントリーの約 71% が +100% に到達」という高い前提です（ムーンバッグの上振れを除く）。
          まずは推奨の -50% でデモ運用し、実際の到達率を確認してからの変更をおすすめします。
        </p>
        <p class="xs dim">
          最低限の監査 = 総合判定 + 初期流動性 $5k 以上 + mint/freeze 権限の残存が判明していない + 同名再発行 2 件未満。
          監査は取得できた公開情報に基づく選定支援であり、安全性・利益を保証しません。
        </p>
      </div>
      <div class="field">
        <StrategyPicker context="solana" />
      </div>
      <div class="field">
        <div v-if="!usesAutoPipeline(method)" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
          <span class="small dim">対象トークン（{{ selectedPairs.length }} / {{ MAX_PAIRS_PER_SESSION }} 選択中）</span>
          <button
            class="btn btn-sm"
            type="button"
            :disabled="method === 'snipe' ? solana.freshRecommended.length === 0 : solana.recommended.length === 0"
            @click="applyRecommendation"
          >
            <Bot :size="14" aria-hidden="true" /> AI のおすすめを使う
          </button>
        </div>
        <div v-else style="margin-bottom: 6px">
          <span class="small dim">
            現在の監視状況: 新規上場 {{ solana.freshTokens.length }} 件中、監査通過 {{ solana.freshAuditPassedCount(autoAllowCaution) }} 件
          </span>
        </div>

        <!-- スナイプ / 自動スナイプ: 新規上場（48h以内）トークンのリスト -->
        <template v-if="usesFresh(method)">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px">
            <span class="xs faint">
              監視中 {{ solana.freshTokens.length }} 件
              <template v-if="solana.freshTokens.length > solana.freshDisplay.length">
                / おすすめ上位 {{ solana.freshDisplay.length }} 件を表示
              </template>
              <template v-if="solana.freshFetchedAt">（プール更新: {{ fmtAgo(solana.freshFetchedAt) }}。各トークンの情報は最終確認時点）</template>
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
              v-for="s in solana.freshDisplay"
              :key="s.token.pairAddress"
              :score="s"
              :selected="method === 'snipe' && selectedPairs.includes(s.token.pairAddress)"
              @select="(addr) => method === 'snipe' && togglePair(addr)"
            />
          </div>
          <p class="xs faint" style="margin-top: 6px">
            <template v-if="method === 'auto-snipe'">
              上のリストは監視プールのおすすめ上位です（選択は不要）。新規発行トークンは約 30 秒ごとの監視で
              随時プールへ追加され（48 時間で自動失効）、監査通過トークンへ執行直前の最新価格を再取得したうえで自動エントリーします。
            </template>
            <template v-else-if="method === 'moonbag'">
              上のリストは監視プールのおすすめ上位です（選択は不要）。エントリーは自動スナイプと同じ常時監視・監査・
              執行直前の価格再取得で行い、+100% 到達で 70% を売却して残りをムーンバッグとして保持し続けます。
            </template>
            <template v-else>
              シグナル（mint 権限・再発行照合等）は取得できた公開情報に基づく選定支援であり、安全性や利益を保証しません。
            </template>
          </p>
        </template>
        <p v-else class="xs faint">下部の「トークンスクリーニング」からカードをタップして選択します。</p>
      </div>
      <button
        class="btn btn-primary"
        style="width: 100%"
        type="button"
        :disabled="(!usesAutoPipeline(method) && selectedPairs.length === 0) || allocatedUsd < 100 || solana.sessions.length >= MAX_DEGEN_SESSIONS"
        @click="startSession"
      >
        <Play :size="15" aria-hidden="true" /> 魔界トレードを開始
      </button>
      <p v-if="solana.sessions.length >= MAX_DEGEN_SESSIONS" class="xs" style="color: var(--warn); margin-top: 6px">
        同時実行の上限（{{ MAX_DEGEN_SESSIONS }} 件）に達しています。不要なセッションを終了すると新規開始できます。
      </p>
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
          <span>{{ a.name ?? DEGEN_METHOD_LABELS[a.method] ?? a.method }}</span>
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
.session-card { border-left: 3px solid #14f195; }
.stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 12px; }
@media (min-width: 768px) { .stats-grid { grid-template-columns: repeat(4, 1fr); } }
.controls { display: flex; gap: 8px; margin-top: 12px; flex-wrap: wrap; }
.pos-row { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.pos-row:last-child { border-bottom: none; }
.pos-btn {
  width: 100%;
  border-top: none;
  border-left: none;
  border-right: none;
  background: transparent;
  color: var(--text);
  text-align: left;
  cursor: pointer;
  padding: 8px 0;
  /* font ショートハンドは .small の font-size を打ち消すため個別指定 */
  font-family: inherit;
  line-height: inherit;
}
.pos-btn .chev { margin-left: auto; }
.moonbag-line { color: var(--accent); display: flex; align-items: center; gap: 5px; flex-wrap: wrap; }
.badge-moonbag {
  background: var(--accent-soft);
  color: var(--accent);
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
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

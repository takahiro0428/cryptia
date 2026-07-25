<script setup lang="ts">
import {
  Bot,
  Download,
  ExternalLink,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Upload,
  Wallet,
  Zap,
} from '@lucide/vue'
import { ERROR_CODES, formatError } from '~/shared/errors'
import { fmtQty, fmtTime, fmtUsd } from '~/shared/format'
import { canEnableAutoTrade } from '~/shared/tradeGuard'
import type { TradeDecision } from '~/shared/types'
import { aiAuthHeaders } from '~/composables/useFirebase'
import { useMarketStore } from '~/stores/market'
import { useSolanaStore } from '~/stores/solana'
import { useStrategyStore } from '~/stores/strategy'
import { useUiStore } from '~/stores/ui'
import {
  useWalletStore,
  LAMPORTS_PER_SOL,
  SOL_MINT,
  type JupiterQuote,
  type WalletOption,
} from '~/stores/wallet'

// 実トレード（UC-6 / F-07, F-08）。買い（SOL→トークン）と売り（トークン→SOL）に対応
const wallet = useWalletStore()
const market = useMarketStore()
const solana = useSolanaStore()
const strategy = useStrategyStore()
const ui = useUiStore()

/** 主要 SPL トークン（手動選択用の静的マスタ） */
const KNOWN_TOKENS = [
  { symbol: 'USDC', name: 'USD Coin', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' },
  { symbol: 'JUP', name: 'Jupiter', mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN' },
  { symbol: 'BONK', name: 'Bonk', mint: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263' },
  { symbol: 'WIF', name: 'dogwifhat', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm' },
]

const direction = ref<'buy' | 'sell'>('buy')
const outMint = ref(KNOWN_TOKENS[0].mint)
const outSymbol = ref(KNOWN_TOKENS[0].symbol)
const amountSol = ref(0.1)
/** 売り方向: 選択中の保有トークン mint と数量（トークン単位） */
const sellMint = ref('')
const sellAmount = ref(0)
const quote = ref<JupiterQuote | null>(null)
const quoting = ref(false)
const showConfirm = ref(false)
const aiThinking = ref(false)
const lastAiDecision = ref<TradeDecision | null>(null)

const solPriceUsd = computed(() => market.tickerOf('solana')?.priceUsd ?? 0)
const guardReady = computed(() => canEnableAutoTrade(wallet.guard))

// 価格の信頼性判定（AUDIT-1）: モック価格・鮮度切れの間は実トレードを全停止する。
const PRICE_STALE_MS = 2 * 60 * 1000
const nowTick = ref(Date.now())
let nowTimer: ReturnType<typeof setInterval> | null = null
const priceReady = computed(
  () =>
    !market.usingMockData &&
    solPriceUsd.value > 0 &&
    nowTick.value - market.lastUpdatedAt < PRICE_STALE_MS,
)

// AI おすすめ（Solana スクリーナーの適格上位）。モック時は非表示（AUDIT-4）
const aiPicks = computed(() => (solana.usingMockData ? [] : solana.recommended.slice(0, 4)))

/** mint → 表示シンボルの解決（既知トークン → スクリーナー → 短縮 mint） */
function symbolForMint(mint: string): string {
  const known = KNOWN_TOKENS.find((t) => t.mint === mint)
  if (known) return known.symbol
  const screened = solana.tokens.find((t) => t.baseAddress === mint)
  if (screened) return screened.baseSymbol
  return `${mint.slice(0, 4)}…${mint.slice(-4)}`
}

const sellBalance = computed(() => wallet.tokenBalances.find((b) => b.mint === sellMint.value))
/** 売却数量の raw 変換（decimals 対応・保有超過はクランプ） */
const sellAmountRaw = computed(() => {
  const bal = sellBalance.value
  if (!bal || sellAmount.value <= 0) return '0'
  const clamped = Math.min(sellAmount.value, bal.uiAmount)
  const raw = BigInt(Math.floor(clamped * 10 ** bal.decimals))
  const max = BigInt(bal.amountRaw)
  return (raw > max ? max : raw).toString()
})
/** 見積りの受取 SOL（buy: 支払 SOL / sell: 受取見込み SOL） */
const quoteSolAmount = computed(() => {
  if (!quote.value) return 0
  return direction.value === 'buy'
    ? amountSol.value
    : Number(quote.value.outAmount) / LAMPORTS_PER_SOL
})
/** 実際に売却される数量（quote の入力側から導出。クランプ後の実行値: ISSUE-P8-1） */
const executedSellAmount = computed(() => {
  if (!quote.value || !sellBalance.value) return 0
  return Number(quote.value.inAmount) / 10 ** sellBalance.value.decimals
})
/** 売却トークンの参照 USD 価値（スクリーナー価格ベース。取れない場合 0） */
const sellTokenRefUsd = computed(() => {
  const token = solana.tokens.find((t) => t.baseAddress === sellMint.value)
  if (!token || !sellBalance.value) return 0
  return token.priceUsd * Math.min(sellAmount.value, sellBalance.value.uiAmount)
})
/**
 * ガード判定・表示用の概算 USD。
 * 売りは「受取 SOL 価値」と「売却トークンの参照価値」の大きい方を採用する
 * （高スリッページ売却で日次上限への計上が過小になるのを防ぐ: AUDIT-P8-2）
 */
const approxUsd = computed(() =>
  direction.value === 'buy'
    ? amountSol.value * solPriceUsd.value
    : Math.max(quoteSolAmount.value * solPriceUsd.value, sellTokenRefUsd.value),
)

function pickKnown(mint: string, symbol: string) {
  outMint.value = mint
  outSymbol.value = symbol
  quote.value = null
}

function assertPriceReady(): boolean {
  if (!priceReady.value) {
    ui.notify(
      '実勢価格を取得できないため注文を一時停止しています（価格接続の回復をお待ちください）',
      'error',
      ERROR_CODES.TRADE_GUARD_BLOCKED,
    )
    return false
  }
  return true
}

async function fetchQuote() {
  if (!assertPriceReady()) return
  quoting.value = true
  quote.value = null
  try {
    if (direction.value === 'buy') {
      quote.value = await wallet.getQuote(outMint.value, amountSol.value)
    } else {
      if (!sellBalance.value || sellAmountRaw.value === '0') {
        ui.notify('売却するトークンと数量を指定してください', 'warn')
        return
      }
      // 入力値を保有量にクランプして表示と実行値を一致させる（ISSUE-P8-1）
      sellAmount.value = Math.min(sellAmount.value, sellBalance.value.uiAmount)
      quote.value = await wallet.getQuoteRaw(sellMint.value, SOL_MINT, sellAmountRaw.value)
    }
    showConfirm.value = true
  } catch (err) {
    const { code, message } = formatError(err)
    ui.notify(message, 'error', code)
  } finally {
    quoting.value = false
  }
}

async function confirmSwap() {
  if (!quote.value) return
  if (!assertPriceReady()) return
  showConfirm.value = false
  try {
    await wallet.executeSwap(quote.value, {
      side: direction.value,
      outSymbol: direction.value === 'buy' ? outSymbol.value : symbolForMint(sellMint.value),
      amountSol: quoteSolAmount.value,
      approxUsd: approxUsd.value,
      auto: false,
      reason: direction.value === 'buy' ? '手動買い注文' : '手動売り注文',
    })
  } catch {
    /* エラーはストア内で通知済み */
  } finally {
    quote.value = null
  }
}

/** AI に判断させる（選択中のスクリーナートークンに対して） */
async function askAi() {
  if (!assertPriceReady()) return
  const pick = aiPicks.value.find((s) => s.token.baseAddress === outMint.value) ?? aiPicks.value[0]
  if (!pick) {
    ui.notify('AI が評価できる適格トークンがありません', 'warn')
    return
  }
  aiThinking.value = true
  try {
    const decision = await $fetch<TradeDecision>('/api/ai/degen-decision', {
      method: 'POST',
      body: {
        token: pick.token,
        strategy: strategy.docFor('live'),
        exposureRatio: 0,
        unrealizedPct: null,
        library: strategy.allDocs.slice(0, 10),
      },
      headers: await aiAuthHeaders(),
      timeout: 12_000,
    })
    lastAiDecision.value = decision
    if (decision.action === 'buy') {
      direction.value = 'buy'
      pickKnown(pick.token.baseAddress, pick.token.baseSymbol)
      ui.notify(`AI 判断: ${pick.token.baseSymbol} を買い（見積りを確認して署名してください）`)
      await fetchQuote()
    } else {
      ui.notify(`AI 判断: ${decision.action === 'hold' ? '様子見' : '売り推奨'} — ${decision.reason}`, 'info')
    }
  } catch (err) {
    const { code, message } = formatError(err)
    ui.notify(message, 'error', code)
  } finally {
    aiThinking.value = false
  }
}

const explorerUrl = (txid: string) => `https://solscan.io/tx/${txid}`

/** 取引履歴の JSON エクスポート（AUDIT-9） */
function exportLog() {
  const blob = new Blob([wallet.exportLog()], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `cryptia-trade-log-${new Date().toISOString().slice(0, 10)}.json`
  a.click()
  URL.revokeObjectURL(url)
}

const importInput = ref<HTMLInputElement | null>(null)
async function importLog(e: Event) {
  const file = (e.target as HTMLInputElement).files?.[0]
  if (!file) return
  const added = wallet.importLog(await file.text())
  ui.notify(added > 0 ? `${added} 件の取引履歴を取り込みました` : '取り込める新しい履歴がありませんでした')
  if (importInput.value) importInput.value.value = ''
}

/**
 * 検出済みウォレット（Phantom / Bitget Wallet / Solflare / 汎用 injected）。
 * 拡張・アプリ内ブラウザの provider 注入はページ読込より遅れることがあるため、
 * 未接続の間は定期的に再検出する。
 */
const detectedWallets = ref<WalletOption[]>([])
let detectTimer: ReturnType<typeof setInterval> | null = null
function refreshDetectedWallets() {
  if (!wallet.connected) detectedWallets.value = wallet.detectWallets()
}

onMounted(async () => {
  refreshDetectedWallets()
  detectTimer = setInterval(refreshDetectedWallets, 2_000)
  await strategy.restoreState()
  await wallet.restoreState()
  await solana.restoreState()
  if (solana.tokens.length === 0) await solana.fetchTokens()
  nowTimer = setInterval(() => (nowTick.value = Date.now()), 15_000)
})
onBeforeUnmount(() => {
  if (nowTimer) clearInterval(nowTimer)
  if (detectTimer) clearInterval(detectTimer)
})
useHead({ title: '実トレード | Cryptia' })
</script>

<template>
  <div>
    <div class="card-title">
      <h1><Zap :size="20" class="icon-inline" aria-hidden="true" />実トレード</h1>
      <span class="badge badge-warn">実資金</span>
    </div>
    <DisclaimerBanner :always="true" />

    <!-- 価格接続の異常時は実トレードを全停止する（AUDIT-1） -->
    <div v-if="!priceReady" class="disclaimer" role="alert">
      <TriangleAlert :size="14" class="icon-inline" aria-hidden="true" />
      実勢価格を取得できないため、実トレード（見積り・発注・AI判断）を一時停止しています。
      価格接続の回復後に自動で再開します。
    </div>
    <div v-if="solana.usingMockData" class="disclaimer" role="alert">
      <TriangleAlert :size="14" class="icon-inline" aria-hidden="true" />
      DexScreener に接続できないため、AI おすすめトークンは表示されません（参考データを実資金取引に使用しないための保護です）。
    </div>

    <!-- ウォレット接続 -->
    <section class="card">
      <div class="card-title">
        <h2><Wallet :size="17" class="icon-inline" aria-hidden="true" />ウォレット</h2>
        <span v-if="wallet.connected" class="badge badge-up">{{ wallet.walletName || '接続中' }}</span>
      </div>
      <template v-if="!wallet.connected">
        <p class="small dim">
          ウォレットを接続すると Jupiter アグリゲーター経由で実際のスワップを実行できます。
          秘密鍵がアプリに渡ることはなく、署名はウォレット内で完結します。
          対応: Phantom / Bitget Wallet / Solflare / その他 Phantom 互換ウォレット。
        </p>
        <div class="chips">
          <button
            v-for="w in detectedWallets"
            :key="w.id"
            class="btn btn-primary"
            type="button"
            @click="wallet.connect(w.id)"
          >
            <Wallet :size="15" aria-hidden="true" /> {{ w.name }} を接続
          </button>
        </div>
        <p v-if="detectedWallets.length === 0" class="xs warn" style="margin-top: 8px">
          ウォレットが検出されていません。PC はブラウザ拡張（Phantom / Bitget Wallet / Solflare）をインストールし、
          スマホは各ウォレットアプリ内のブラウザ（DApp ブラウザ）でこのページを開いてください。
        </p>
      </template>
      <template v-else>
        <div class="small mono dim" style="word-break: break-all">{{ wallet.publicKey }}</div>
        <div style="display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap">
          <span class="mono bold" style="font-size: 1.1rem">
            <template v-if="wallet.solBalance !== null">{{ wallet.solBalance.toFixed(4) }} SOL</template>
            <template v-else-if="wallet.balanceLoading">残高取得中…</template>
            <template v-else>— SOL</template>
          </span>
          <span v-if="wallet.solBalance !== null && solPriceUsd > 0" class="dim small">
            ≈ {{ fmtUsd(wallet.solBalance * solPriceUsd) }}
          </span>
          <button
            class="btn btn-sm"
            type="button"
            aria-label="残高を更新"
            :disabled="wallet.balanceLoading"
            @click="wallet.refreshBalance()"
          >
            <RefreshCw :size="14" aria-hidden="true" />
          </button>
          <button class="btn btn-sm btn-ghost" type="button" @click="wallet.disconnect()">切断</button>
        </div>
        <p v-if="wallet.balanceError && !wallet.balanceLoading" class="xs warn" style="margin-top: 6px">
          残高を取得できませんでした（CRYPTIA-E505: RPC の混雑・遮断の可能性）。更新ボタンで再試行してください。取引時には残高が再検証されるため、表示が取れなくても資産は安全です。
        </p>
      </template>
    </section>

    <!-- 安全ガード（BR-2） -->
    <section class="card">
      <div class="card-title">
        <h2><ShieldCheck :size="17" class="icon-inline" aria-hidden="true" />取引ガード</h2>
        <span class="badge" :class="guardReady ? 'badge-up' : 'badge-warn'">
          {{ guardReady ? '設定済み' : '未設定' }}
        </span>
      </div>
      <label class="field" style="display: flex; gap: 8px; align-items: flex-start">
        <input
          type="checkbox"
          :checked="wallet.guard.riskConsentAt !== null"
          :disabled="wallet.guard.riskConsentAt !== null"
          style="margin-top: 4px"
          @change="wallet.consentRisk()"
        />
        <span class="small">
          暗号資産の実取引には元本喪失・流動性・スマートコントラクト等の重大なリスクがあることを理解し、
          自己責任で取引を行うことに同意します（同意は取り消せません。取引を止めるには上限を 0 にしてください）
        </span>
      </label>
      <div class="grid grid-2">
        <label class="field">
          <span>1回あたり上限（USD）</span>
          <input
            :value="wallet.guard.maxPerTradeUsd || ''"
            type="number"
            class="input"
            min="0"
            placeholder="例: 50"
            inputmode="numeric"
            @change="(e) => wallet.setGuard({ maxPerTradeUsd: Number((e.target as HTMLInputElement).value) || 0 })"
          />
        </label>
        <label class="field">
          <span>1日あたり上限（USD）</span>
          <input
            :value="wallet.guard.maxPerDayUsd || ''"
            type="number"
            class="input"
            min="0"
            placeholder="例: 200"
            inputmode="numeric"
            @change="(e) => wallet.setGuard({ maxPerDayUsd: Number((e.target as HTMLInputElement).value) || 0 })"
          />
        </label>
      </div>
      <div class="small dim">本日の約定合計: {{ fmtUsd(wallet.todaysSpentUsd) }} / 上限 {{ wallet.guard.maxPerDayUsd > 0 ? fmtUsd(wallet.guard.maxPerDayUsd) : '未設定' }}</div>
    </section>

    <!-- 注文パネル -->
    <section class="card">
      <h2>スワップ注文</h2>
      <StrategyPicker context="live" />
      <div class="tabs" style="max-width: 320px; margin-bottom: 12px" role="tablist">
        <button class="tab" :class="{ active: direction === 'buy' }" role="tab" :aria-selected="direction === 'buy'" type="button" @click="direction = 'buy'; quote = null">
          買う（SOL → トークン）
        </button>
        <button class="tab" :class="{ active: direction === 'sell' }" role="tab" :aria-selected="direction === 'sell'" type="button" @click="direction = 'sell'; quote = null">
          売る（トークン → SOL）
        </button>
      </div>

      <!-- 買い方向 -->
      <template v-if="direction === 'buy'">
        <div class="field">
          <span class="small dim"><Bot :size="13" class="icon-inline" aria-hidden="true" />AI のおすすめ（スクリーニング適格上位）</span>
          <div class="chips">
            <button
              v-for="s in aiPicks"
              :key="s.token.pairAddress"
              class="chip"
              :class="{ on: outMint === s.token.baseAddress }"
              type="button"
              @click="pickKnown(s.token.baseAddress, s.token.baseSymbol)"
            >
              {{ s.token.baseSymbol }} <span class="xs faint">{{ s.total }}</span>
            </button>
            <span v-if="aiPicks.length === 0" class="xs faint">適格トークンの取得待ち…</span>
          </div>
        </div>

        <div class="field">
          <span class="small dim">主要トークンから選ぶ</span>
          <div class="chips">
            <button
              v-for="t in KNOWN_TOKENS"
              :key="t.mint"
              class="chip"
              :class="{ on: outMint === t.mint }"
              type="button"
              @click="pickKnown(t.mint, t.symbol)"
            >
              {{ t.symbol }}
            </button>
          </div>
        </div>

        <label class="field">
          <span>支払い数量（SOL）</span>
          <input v-model.number="amountSol" type="number" class="input" min="0.001" step="0.01" inputmode="decimal" />
          <span class="xs dim">≈ {{ fmtUsd(amountSol * solPriceUsd) }}</span>
        </label>
      </template>

      <!-- 売り方向 -->
      <template v-else>
        <div class="field">
          <span class="small dim">売却するトークン（ウォレット内の保有）</span>
          <div class="chips">
            <button
              v-for="b in wallet.tokenBalances.slice(0, 12)"
              :key="b.mint"
              class="chip"
              :class="{ on: sellMint === b.mint }"
              type="button"
              @click="sellMint = b.mint; sellAmount = 0; quote = null"
            >
              {{ symbolForMint(b.mint) }} <span class="xs faint">{{ fmtQty(b.uiAmount) }}</span>
            </button>
            <span v-if="wallet.tokenBalances.length === 0" class="xs faint">
              保有トークンがありません（接続後に自動取得されます）
            </span>
          </div>
        </div>
        <label v-if="sellBalance" class="field">
          <span>売却数量（保有: {{ fmtQty(sellBalance.uiAmount) }}）</span>
          <input v-model.number="sellAmount" type="number" class="input" min="0" :max="sellBalance.uiAmount" step="any" inputmode="decimal" />
          <button class="btn btn-sm btn-ghost" type="button" @click="sellAmount = sellBalance.uiAmount">全量</button>
        </label>
      </template>

      <div style="display: flex; gap: 8px; flex-wrap: wrap">
        <button
          class="btn btn-primary"
          type="button"
          :disabled="!wallet.connected || quoting || !priceReady || (direction === 'buy' ? amountSol <= 0 : sellAmountRaw === '0')"
          @click="fetchQuote"
        >
          {{ quoting ? '見積り取得中…' : '見積りを取得' }}
        </button>
        <button
          class="btn"
          type="button"
          :disabled="!wallet.connected || aiThinking || !priceReady"
          @click="askAi"
        >
          <Bot :size="15" aria-hidden="true" />
          {{ aiThinking ? 'AI 分析中…' : 'AI に判断させる' }}
        </button>
      </div>
      <p v-if="lastAiDecision" class="small dim" style="margin-top: 8px">
        直近の AI 判断: <b>{{ lastAiDecision.action }}</b>（確信度 {{ lastAiDecision.confidence }}%）— {{ lastAiDecision.reason }}
      </p>
      <p class="xs faint" style="margin-top: 8px">
        AI 自動実トレードを含むすべての注文でウォレット署名の確認が入ります。
      </p>
    </section>

    <!-- 確認ダイアログ（署名前に内容を明示: NFR セキュリティ） -->
    <div v-if="showConfirm && quote" class="modal-overlay" role="dialog" aria-modal="true">
      <div class="card modal">
        <h2>注文内容の確認</h2>
        <table class="data">
          <tbody>
            <tr v-if="direction === 'buy'">
              <td class="dim">支払い</td>
              <td class="mono">{{ amountSol }} SOL（≈ {{ fmtUsd(approxUsd) }}）</td>
            </tr>
            <tr v-else>
              <td class="dim">売却</td>
              <!-- 表示は入力値ではなく quote 由来の実行数量（ISSUE-P8-1） -->
              <td class="mono">{{ fmtQty(executedSellAmount) }} {{ symbolForMint(sellMint) }}</td>
            </tr>
            <tr v-if="direction === 'buy'">
              <td class="dim">受け取り</td>
              <td class="mono">{{ outSymbol }}（見積り {{ quote.outAmount }} raw）</td>
            </tr>
            <tr v-else>
              <td class="dim">受け取り</td>
              <!-- 受取価値は実際の quote 由来を表示（max() 後のガード計上額と混同しない: ISSUE-P8-12） -->
              <td class="mono">{{ quoteSolAmount.toFixed(6) }} SOL（≈ {{ fmtUsd(quoteSolAmount * solPriceUsd) }}）</td>
            </tr>
            <tr v-if="direction === 'sell' && approxUsd > quoteSolAmount * solPriceUsd * 1.05">
              <td class="dim">上限への計上額</td>
              <td class="mono">{{ fmtUsd(approxUsd) }} <span class="xs faint">（トークン参照価値・保守値）</span></td>
            </tr>
            <tr><td class="dim">価格影響</td><td class="mono" :class="Number(quote.priceImpactPct) > 1 ? 'down' : ''">{{ Number(quote.priceImpactPct).toFixed(3) }}%</td></tr>
            <tr><td class="dim">スリッページ許容</td><td class="mono">1.0%</td></tr>
          </tbody>
        </table>
        <p class="xs warn">この後 {{ wallet.walletName || 'ウォレット' }} の署名確認が表示されます。内容を必ず確認してください。</p>
        <div style="display: flex; gap: 8px">
          <button class="btn btn-danger" type="button" :disabled="wallet.busy" @click="confirmSwap">
            {{ wallet.busy ? '送信中…' : '署名して実行' }}
          </button>
          <button class="btn btn-ghost" type="button" @click="showConfirm = false">キャンセル</button>
        </div>
      </div>
    </div>

    <!-- 取引履歴 -->
    <section class="card">
      <div class="card-title">
        <h2>実トレード履歴</h2>
        <div style="display: flex; gap: 6px; align-items: center">
          <span class="xs faint">{{ wallet.tradeLog.length }} 件</span>
          <button class="btn btn-sm btn-ghost" type="button" :disabled="wallet.tradeLog.length === 0" aria-label="履歴を保存" @click="exportLog">
            <Download :size="14" aria-hidden="true" /> 保存
          </button>
          <button class="btn btn-sm btn-ghost" type="button" aria-label="履歴を復元" @click="importInput?.click()">
            <Upload :size="14" aria-hidden="true" /> 復元
          </button>
          <input ref="importInput" type="file" accept="application/json" hidden @change="importLog" />
        </div>
      </div>
      <p class="xs faint">
        履歴のバックアップを推奨します（オンチェーンの原本は Solscan で確認できます）。
        アカウント連携済みなら端末を変えてもデータは引き継がれます。
      </p>
      <p v-if="wallet.tradeLog.length === 0" class="dim small">まだ実トレードはありません</p>
      <div v-for="t in wallet.tradeLog.slice(0, 30)" :key="t.txid" class="log-row small">
        <span class="xs faint nowrap">{{ fmtTime(t.at) }}</span>
        <span class="badge" :class="t.side === 'buy' ? 'badge-up' : 'badge-down'">{{ t.side === 'buy' ? '買' : '売' }}</span>
        <span class="bold">{{ t.outSymbol }}</span>
        <span class="mono">{{ t.inAmountSol.toFixed(4) }} SOL</span>
        <span v-if="t.auto" class="badge badge-accent">AI自動</span>
        <a :href="explorerUrl(t.txid)" target="_blank" rel="noopener noreferrer" class="xs" style="display: inline-flex; align-items: center; gap: 2px">
          Solscan <ExternalLink :size="11" aria-hidden="true" />
        </a>
      </div>
    </section>

    <!-- アカウント連携（AUDIT-9 本対応） -->
    <AccountLink />
  </div>
</template>

<style scoped>
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
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
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 300;
  padding: 16px;
}
.modal { width: min(94vw, 440px); }
.log-row { display: flex; gap: 10px; align-items: center; padding: 7px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.log-row:last-child { border-bottom: none; }
.log-row a { margin-left: auto; }
</style>

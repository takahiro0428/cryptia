import { defineStore } from 'pinia'
import { decideDegenTrade } from '~/shared/degenAdvisor'
import { ERROR_CODES, formatError } from '~/shared/errors'
import { mockSolanaTokens } from '~/shared/mockData'
import { isTradable, rankTokens } from '~/shared/solanaScoring'
import {
  applyDecision,
  checkLadder,
  createPortfolio,
  DEFAULT_LADDER_RULES,
  executeOrder,
  portfolioEquity,
  positionOf,
  recordEquity,
  summarize,
} from '~/shared/tradeEngine'
import type {
  LadderRule,
  Portfolio,
  PortfolioSummary,
  SolanaToken,
  TokenScore,
  TradeDecision,
} from '~/shared/types'
import { aiAuthHeaders } from '~/composables/useFirebase'
import { persist, restore } from '~/composables/usePersistence'
import { useStrategyStore } from '~/stores/strategy'
import { useUiStore } from '~/stores/ui'

const STORE_KEY = 'solana-degen'
const DEX_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search?q=SOL'
const DEX_PAIRS_URL = 'https://api.dexscreener.com/latest/dex/pairs/solana/'
/** スクリーニング更新間隔（DexScreener レートリミット配慮） */
export const DEGEN_TICK_MS = 30_000

export type DegenMethod = 'ai' | 'ladder'

interface DexPair {
  chainId?: string
  pairAddress?: string
  baseToken?: { address?: string; name?: string; symbol?: string }
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number }
  txns?: { h24?: { buys?: number; sells?: number } }
  pairCreatedAt?: number
}

interface PositionMeta {
  entryPriceUsd: number
  triggered: number[]
}

interface DegenArchive {
  endedAt: number
  summary: PortfolioSummary
  method: DegenMethod
  tokenSymbols: string[]
}

interface PersistedDegen {
  portfolio: Portfolio | null
  running: boolean
  method: DegenMethod
  ladderRules: LadderRule[]
  watchedPairs: string[]
  positionMeta: Record<string, PositionMeta>
  archives: DegenArchive[]
}

function toToken(p: DexPair): SolanaToken | null {
  if (p.chainId !== 'solana' || !p.pairAddress || !p.baseToken?.address) return null
  const priceUsd = Number(p.priceUsd)
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null
  const h24 = p.txns?.h24
  return {
    pairAddress: p.pairAddress,
    baseSymbol: (p.baseToken.symbol ?? '?').slice(0, 20),
    baseName: (p.baseToken.name ?? p.baseToken.symbol ?? '?').slice(0, 60),
    baseAddress: p.baseToken.address,
    priceUsd,
    liquidityUsd: p.liquidity?.usd ?? 0,
    volume24hUsd: p.volume?.h24 ?? 0,
    change24hPct: p.priceChange?.h24 ?? 0,
    ageHours: p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 3_600_000) : 0,
    txns24h: (h24?.buys ?? 0) + (h24?.sells ?? 0),
  }
}

/**
 * Solana 魔界トレードストア（UC-5 / F-05, F-06）。
 * - DexScreener で新興トークンをスクリーニングし、スコアリングで選定支援
 * - 取引手法: AI 取引（Vertex/ロジック） or ラダーロジック（+100%で50%利確等）
 * - 取引はデモ資金で実行（実資金は /trade/live のウォレット接続経由のみ）
 */
export const useSolanaStore = defineStore('solana', {
  state: () => ({
    tokens: [] as SolanaToken[],
    loading: false,
    usingMockData: false,
    lastFetchedAt: 0,
    portfolio: null as Portfolio | null,
    running: false,
    method: 'ladder' as DegenMethod,
    ladderRules: [...DEFAULT_LADDER_RULES] as LadderRule[],
    watchedPairs: [] as string[],
    positionMeta: {} as Record<string, PositionMeta>,
    archives: [] as DegenArchive[],
    ticking: false,
    restored: false,
    _timer: null as ReturnType<typeof setInterval> | null,
    /** セッション世代。await 中に終了/再開始された旧ティックの執行を防ぐ（ISSUE-3） */
    _session: 0,
  }),
  getters: {
    ranked(state): TokenScore[] {
      return rankTokens(state.tokens)
    },
    /** AI おすすめ = 適格（isTradable）かつスコア上位 */
    recommended(): TokenScore[] {
      return this.ranked.filter((s: TokenScore) => isTradable(s)).slice(0, 5)
    },
    tokenOf: (state) => (pairAddress: string) =>
      state.tokens.find((t) => t.pairAddress === pairAddress),
    priceMap(state): Record<string, number> {
      return Object.fromEntries(state.tokens.map((t) => [t.pairAddress, t.priceUsd]))
    },
    summary(state): PortfolioSummary | null {
      if (!state.portfolio) return null
      return summarize(state.portfolio, this.priceMap)
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const saved = await restore<PersistedDegen>(STORE_KEY)
      if (saved) {
        this.portfolio = saved.portfolio
        this.method = saved.method ?? 'ladder'
        this.ladderRules = saved.ladderRules?.length ? saved.ladderRules : [...DEFAULT_LADDER_RULES]
        this.watchedPairs = saved.watchedPairs ?? []
        this.positionMeta = saved.positionMeta ?? {}
        this.archives = saved.archives ?? []
        if (saved.running && this.portfolio) this.startTicking()
      }
      this.restored = true
    },
    _persist() {
      persist<PersistedDegen>(STORE_KEY, {
        portfolio: this.portfolio ? JSON.parse(JSON.stringify(this.portfolio)) : null,
        running: this.running,
        method: this.method,
        ladderRules: JSON.parse(JSON.stringify(this.ladderRules)),
        watchedPairs: [...this.watchedPairs],
        positionMeta: JSON.parse(JSON.stringify(this.positionMeta)),
        archives: JSON.parse(JSON.stringify(this.archives)),
      })
    },
    async fetchTokens() {
      this.loading = this.tokens.length === 0
      try {
        const res = await fetch(DEX_SEARCH_URL)
        if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`)
        const data = (await res.json()) as { pairs?: DexPair[] }
        const tokens = (data.pairs ?? [])
          .map(toToken)
          .filter((t): t is SolanaToken => t !== null)
          // SOL/USDC 等のメジャーペア自体は除外し、新興トークン側に絞る
          .filter((t) => !['SOL', 'WSOL', 'USDC', 'USDT'].includes(t.baseSymbol.toUpperCase()))
        if (tokens.length === 0) throw new Error('DexScreener の応答に Solana ペアがありません')
        // 保有中トークンの価格は必ず維持する（リストから外れても追跡）
        const held = this.tokens.filter(
          (t) =>
            this.watchedPairs.includes(t.pairAddress) &&
            !tokens.some((n) => n.pairAddress === t.pairAddress),
        )
        this.tokens = [...tokens, ...held]
        this.usingMockData = false
        this.lastFetchedAt = Date.now()
        await this.refreshHeldPairs()
      } catch (err) {
        console.warn(`[${ERROR_CODES.DEX_FETCH_FAILED}] ${err instanceof Error ? err.message : err}`)
        if (this.tokens.length === 0) {
          this.tokens = mockSolanaTokens()
          this.usingMockData = true
          this.lastFetchedAt = Date.now()
        }
      } finally {
        this.loading = false
      }
    },
    /** 保有中でリストから消えたペアの価格を個別取得する（モック時はスキップ） */
    async refreshHeldPairs() {
      if (this.usingMockData) return
      const missing = this.watchedPairs.filter(
        (addr) => !this.tokens.some((t) => t.pairAddress === addr),
      )
      if (missing.length === 0) return
      try {
        const res = await fetch(`${DEX_PAIRS_URL}${missing.join(',')}`)
        if (!res.ok) return
        const data = (await res.json()) as { pairs?: DexPair[] }
        for (const p of data.pairs ?? []) {
          const token = toToken(p)
          if (token) this.tokens.push(token)
        }
      } catch {
        /* 個別取得失敗は次ティックで再試行（原則4） */
      }
    },
    /** セッション開始。ladder は即時等分エントリー、ai はティックごとに判断 */
    async start(allocatedUsd: number, pairAddresses: string[], method: DegenMethod) {
      const ui = useUiStore()
      if (this.running) {
        ui.notify('魔界トレードは既に実行中です', 'warn')
        return
      }
      if (pairAddresses.length === 0) {
        ui.notify('取引対象のトークンを選択してください', 'warn')
        return
      }
      try {
        this.archiveCurrent()
        this._session++
        this.portfolio = createPortfolio(allocatedUsd)
        this.watchedPairs = [...pairAddresses]
        this.method = method
        this.positionMeta = {}

        if (method === 'ladder') {
          // ラダー方式: 割当資金を等分して即時エントリーし、以後は出口ルールのみ実行
          const perToken = allocatedUsd / pairAddresses.length
          for (const addr of pairAddresses) {
            const token = this.tokenOf(addr)
            if (!token || token.priceUsd <= 0) continue
            const result = executeOrder(this.portfolio, {
              assetId: addr,
              side: 'buy',
              notionalUsd: perToken,
              priceUsd: token.priceUsd,
              reason: `ラダー戦略の初期エントリー（${token.baseSymbol} へ等分投入）`,
              strategy: 'ラダーロジック',
            })
            this.portfolio = result.portfolio
            this.positionMeta[addr] = { entryPriceUsd: token.priceUsd, triggered: [] }
          }
        }

        this.startTicking()
        this._persist()
        ui.notify(`魔界トレードを開始しました（${method === 'ladder' ? 'ラダーロジック' : 'AI 取引'} / $${allocatedUsd.toLocaleString()}）`)
      } catch (err) {
        const { code, message } = formatError(err)
        ui.notify(message, 'error', code)
      }
    },
    startTicking() {
      if (this._timer) return
      this.running = true
      // 再開状態を即時永続化する（リロードで停止状態に巻き戻さない: 原則2）
      this._persist()
      this._timer = setInterval(() => void this.tick(), DEGEN_TICK_MS)
      void this.tick()
    },
    stop() {
      if (this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
      this.running = false
      this._persist()
    },
    archiveCurrent() {
      if (!this.portfolio || this.portfolio.orders.length === 0) {
        this.portfolio = null
        return
      }
      const symbols = this.watchedPairs.map((a) => this.tokenOf(a)?.baseSymbol ?? a.slice(0, 6))
      this.archives.unshift({
        endedAt: Date.now(),
        summary: summarize(this.portfolio, this.priceMap),
        method: this.method,
        tokenSymbols: symbols,
      })
      this.archives = this.archives.slice(0, 20)
      this._session++
      this.portfolio = null
      this.positionMeta = {}
    },
    endSession() {
      this.stop()
      this.archiveCurrent()
      this._persist()
      useUiStore().notify('魔界トレードのセッションを終了し、結果を保存しました')
    },
    async tick() {
      if (this.ticking || !this.running || !this.portfolio) return
      this.ticking = true
      const session = this._session
      try {
        await this.fetchTokens()
        // await 中にセッションが終了/再開始されていたら旧判断を執行しない（ISSUE-3）
        if (this._session !== session || !this.running || !this.portfolio) return
        const strategy = useStrategyStore().activeDoc
        const prices = this.priceMap

        for (const addr of [...this.watchedPairs]) {
          if (!this.portfolio) break
          const token = this.tokenOf(addr)
          if (!token || token.priceUsd <= 0) continue
          const pos = positionOf(this.portfolio, addr)

          if (this.method === 'ladder') {
            if (!pos) continue
            const meta = this.positionMeta[addr]
            if (!meta) continue
            const fired = checkLadder(meta.entryPriceUsd, token.priceUsd, this.ladderRules, meta.triggered)
            for (const { index, rule } of fired) {
              const current = positionOf(this.portfolio, addr)
              if (!current || current.quantity <= 0) break
              // 数量指定で発注（notional 逆算の誤差で全量損切りが失敗しない: ISSUE-2）
              const sellQty = current.quantity * rule.sellRatio
              if (sellQty * token.priceUsd < 0.01) {
                meta.triggered.push(index)
                continue
              }
              try {
                const result = executeOrder(this.portfolio, {
                  assetId: addr,
                  side: 'sell',
                  quantity: sellQty,
                  priceUsd: token.priceUsd,
                  reason:
                    rule.triggerPct >= 0
                      ? `ラダー利確: +${rule.triggerPct}% 到達で ${Math.round(rule.sellRatio * 100)}% 決済`
                      : `ラダー損切り: ${rule.triggerPct}% 到達で ${Math.round(rule.sellRatio * 100)}% 決済`,
                  strategy: 'ラダーロジック',
                })
                this.portfolio = result.portfolio
                meta.triggered.push(index)
              } catch (err) {
                const { code, message } = formatError(err)
                console.warn(`[${code}] ${message}`)
              }
            }
          } else {
            // AI 取引
            const equity = portfolioEquity(this.portfolio, prices)
            const exposureRatio = equity > 0 ? ((pos?.quantity ?? 0) * token.priceUsd) / equity : 0
            const unrealizedPct =
              pos && pos.avgCostUsd > 0
                ? ((token.priceUsd - pos.avgCostUsd) / pos.avgCostUsd) * 100
                : null
            let decision: TradeDecision
            try {
              decision = await $fetch<TradeDecision>('/api/ai/degen-decision', {
                method: 'POST',
                body: {
                  token,
                  strategy,
                  exposureRatio,
                  unrealizedPct,
                  library: useStrategyStore().allDocs.slice(0, 10),
                },
                headers: await aiAuthHeaders(),
                timeout: 12_000,
              })
            } catch {
              decision = decideDegenTrade(token, { strategy, unrealizedPct, exposureRatio })
            }
            // await 中のセッション切替を検知したら旧判断を破棄（ISSUE-3）
            if (this._session !== session || !this.running || !this.portfolio) return
            try {
              const result = applyDecision(this.portfolio, decision, {
                assetId: addr,
                priceUsd: token.priceUsd,
                strategy: strategy.name,
                prices,
              })
              if (result) {
                this.portfolio = result.portfolio
                if (result.order.side === 'buy' && !this.positionMeta[addr]) {
                  this.positionMeta[addr] = { entryPriceUsd: token.priceUsd, triggered: [] }
                }
                if (result.order.side === 'sell' && !positionOf(this.portfolio, addr)) {
                  delete this.positionMeta[addr]
                }
              }
            } catch (err) {
              const { code, message } = formatError(err)
              console.warn(`[${code}] ${message}`)
            }
          }
        }

        if (this.portfolio) this.portfolio = recordEquity(this.portfolio, this.priceMap)
        this._persist()
      } finally {
        this.ticking = false
      }
    },
  },
})

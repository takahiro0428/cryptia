import { defineStore } from 'pinia'
import { decideDegenTrade } from '~/shared/degenAdvisor'
import {
  DEX_PAIRS_URL,
  DEX_SEARCH_URL,
  discoverFreshPairs,
  extractSnsSignals,
  isValidAddress,
  toToken,
  type DexPair,
} from '~/shared/dexscreener'
import { ERROR_CODES, formatError } from '~/shared/errors'
import { mockSolanaTokens } from '~/shared/mockData'
import {
  scoreFreshToken,
  SNIPE_LADDER_RULES,
  SNIPE_MAX_AGE_HOURS,
  type FreshTokenSignals,
  type SnipeScore,
} from '~/shared/snipeScoring'
import { fitArchivesToBudget, utf8Bytes } from '~/shared/persistBudget'
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
  Order,
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
/** 新規トークンリストのキャッシュ有効期間 */
const FRESH_TTL_MS = 2 * 60 * 1000
/** スクリーニング更新間隔（DexScreener レートリミット配慮） */
export const DEGEN_TICK_MS = 30_000
/** 保有中の表示価格更新間隔（一時停止中も損益をリアルタイム表示する） */
export const DISPLAY_REFRESH_MS = 10_000
/** アーカイブ1件に保存する約定履歴の上限（Firestore ドキュメント容量保護） */
const ARCHIVE_ORDERS_MAX = 100
/** 約定履歴を保持するアーカイブ数（それより古いものはサマリーのみ残す） */
const ARCHIVE_ORDERS_KEEP = 10

export type DegenMethod = 'ai' | 'ladder' | 'snipe'

export const DEGEN_METHOD_LABELS: Record<DegenMethod, string> = {
  ladder: 'ラダー',
  ai: 'AI 取引',
  snipe: 'スナイプ',
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
  /** 約定履歴（閲覧用: F-05）。容量保護のため直近セッション分のみ保持 */
  orders?: Order[]
  /** assetId（ペアアドレス）→ シンボルの対応（履歴表示用） */
  symbols?: Record<string, string>
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

/**
 * Solana 魔界トレードストア（UC-5 / F-05, F-06）。
 * - DexScreener で新興トークンをスクリーニングし、スコアリングで選定支援
 * - 取引手法: AI 取引（Vertex/ロジック） / ラダーロジック / 新規上場スナイプ
 * - 取引はデモ資金で実行（実資金は /trade/live のウォレット接続経由のみ）
 * - DexScreener へ直接到達できない環境では /api/solana/* プロキシへ自動フォールバック
 */
export const useSolanaStore = defineStore('solana', {
  state: () => ({
    tokens: [] as SolanaToken[],
    loading: false,
    usingMockData: false,
    lastFetchedAt: 0,
    /** 保有ポジション価格の最終更新時刻（リアルタイム損益表示の鮮度表示用） */
    lastPricesAt: 0,
    lastError: '' as string,
    /** 新規上場ハンター: 発行直後トークンのスコア済みリスト */
    freshTokens: [] as SnipeScore[],
    freshLoading: false,
    freshFetchedAt: 0,
    /** 新規上場リストの取得失敗理由（空状態とエラーを区別して表示する） */
    freshError: '' as string,
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
    /** DexScreener の取得経路。直接取得に失敗したら proxy に切替える（sticky） */
    _dexVia: 'direct' as 'direct' | 'proxy',
    _pricesBusy: false,
  }),
  getters: {
    ranked(state): TokenScore[] {
      return rankTokens(state.tokens)
    },
    /** AI おすすめ = 適格（isTradable）かつスコア上位 */
    recommended(): TokenScore[] {
      return this.ranked.filter((s: TokenScore) => isTradable(s)).slice(0, 5)
    },
    /** スナイプおすすめ = 「候補」判定の上位 */
    freshRecommended(state): SnipeScore[] {
      return state.freshTokens.filter((s) => s.verdict === 'candidate').slice(0, 3)
    },
    /** スナイプ銘柄はスクリーニングリスト外のこともあるため freshTokens も探索する */
    tokenOf: (state) => (pairAddress: string): SolanaToken | undefined =>
      state.tokens.find((t) => t.pairAddress === pairAddress) ??
      state.freshTokens.find((s) => s.token.pairAddress === pairAddress)?.token,
    priceMap(state): Record<string, number> {
      return Object.fromEntries([
        ...state.freshTokens.map((s) => [s.token.pairAddress, s.token.priceUsd] as const),
        ...state.tokens.map((t) => [t.pairAddress, t.priceUsd] as const),
      ])
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
      const payload: PersistedDegen = {
        portfolio: this.portfolio ? JSON.parse(JSON.stringify(this.portfolio)) : null,
        running: this.running,
        method: this.method,
        ladderRules: JSON.parse(JSON.stringify(this.ladderRules)),
        watchedPairs: [...this.watchedPairs],
        positionMeta: JSON.parse(JSON.stringify(this.positionMeta)),
        archives: JSON.parse(JSON.stringify(this.archives)),
      }
      // Firestore ドキュメント上限（256KB）に収まることを実測で保証する（AUDIT-P9-1）
      payload.archives = fitArchivesToBudget(payload.archives, (a) =>
        utf8Bytes(JSON.stringify({ ...payload, archives: a })),
      )
      persist<PersistedDegen>(STORE_KEY, payload)
    },
    /**
     * DexScreener 取得（直接 → 失敗時は自アプリのプロキシへフォールバック）。
     * 一度プロキシに切替えたら以後はプロキシを使い、プロキシも失敗したら
     * 次回は直接取得から再試行する（自己回復）。
     */
    async _fetchDex<T>(directUrl: string, proxyPath: string): Promise<T> {
      if (this._dexVia === 'direct') {
        try {
          const res = await fetch(directUrl, { signal: AbortSignal.timeout(8_000) })
          if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`)
          return (await res.json()) as T
        } catch {
          const data = await $fetch<T>(proxyPath, { timeout: 12_000 })
          this._dexVia = 'proxy'
          return data
        }
      }
      try {
        return await $fetch<T>(proxyPath, { timeout: 12_000 })
      } catch (err) {
        this._dexVia = 'direct'
        throw err
      }
    },
    async fetchTokens(force = false) {
      this.loading = this.tokens.length === 0 || (force && this.usingMockData)
      if (force) this._dexVia = 'direct'
      try {
        const data = await this._fetchDex<{ pairs?: DexPair[] }>(DEX_SEARCH_URL, '/api/solana/screen')
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
        this.lastError = ''
        this.lastFetchedAt = Date.now()
        this.lastPricesAt = Date.now()
        // 検索リスト外の保有ペア（スナイプ対象等）は held 引き継ぎで価格が古いままのため、
        // 必ず個別取得で置き換える（凍結価格でラダー/AI が執行される問題の防止: ISSUE-P9-H1）
        await this.refreshDisplayPrices()
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err)
        console.warn(`[${ERROR_CODES.DEX_FETCH_FAILED}] ${this.lastError}`)
        if (this.tokens.length === 0) {
          this.tokens = mockSolanaTokens()
          this.usingMockData = true
          this.lastFetchedAt = Date.now()
        }
      } finally {
        this.loading = false
      }
    },
    /**
     * 保有ペア・監視ペアの価格を個別取得して置き換える（replace-or-push）。
     * 呼び出し元は 2 系統:
     *   - tick()（30s・バックグラウンドでも実行）: 検索リスト外ペアの凍結価格防止（ISSUE-P9-H1）
     *   - 画面の表示タイマー（10s）: 一時停止中・復元直後の損益リアルタイム表示
     */
    async refreshDisplayPrices() {
      if (this._pricesBusy || this.usingMockData) return
      // セッションなし（portfolio=null）の間は無駄な取得をしない（クォータ浪費防止）
      if (!this.portfolio) return
      const targets = new Set<string>(this.watchedPairs)
      for (const p of this.portfolio.positions) targets.add(p.assetId)
      const addrs = [...targets].filter(isValidAddress).slice(0, 30)
      if (addrs.length === 0) return
      this._pricesBusy = true
      try {
        const data = await this._fetchDex<{ pairs?: DexPair[] }>(
          `${DEX_PAIRS_URL}${addrs.join(',')}`,
          `/api/solana/pairs?addrs=${addrs.join(',')}`,
        )
        for (const p of data.pairs ?? []) {
          const token = toToken(p)
          if (!token) continue
          const i = this.tokens.findIndex((t) => t.pairAddress === token.pairAddress)
          if (i >= 0) this.tokens[i] = token
          else this.tokens.push(token)
          const fresh = this.freshTokens.find((s) => s.token.pairAddress === token.pairAddress)
          if (fresh) fresh.token.priceUsd = token.priceUsd
        }
        this.lastPricesAt = Date.now()
      } catch {
        /* 表示更新の失敗は次回更新で再試行（原則4） */
      } finally {
        this._pricesBusy = false
      }
    },
    /**
     * 新規上場ハンター: 発行直後（48h 以内）トークンの発見とシグナル収集（F-06）。
     * サーバー経由（/api/solana/fresh）で mint/freeze 権限・再発行照合まで取得し、
     * サーバー未達時はブラウザ直接取得（SNS・流動性のみ）へフォールバックする。
     */
    async fetchFreshTokens(force = false) {
      if (this.freshLoading) return
      if (!force && Date.now() - this.freshFetchedAt < FRESH_TTL_MS) return
      this.freshLoading = true
      try {
        let items: { token: SolanaToken; signals: FreshTokenSignals }[]
        try {
          const data = await $fetch<{ items: { token: SolanaToken; signals: FreshTokenSignals }[] }>(
            '/api/solana/fresh',
            { timeout: 25_000 },
          )
          items = data.items
        } catch {
          items = await this._fetchFreshDirect()
        }
        const rank: Record<SnipeScore['verdict'], number> = { candidate: 0, caution: 1, avoid: 2 }
        this.freshTokens = items
          .map((i) => scoreFreshToken(i.token, i.signals))
          .sort((a, b) => rank[a.verdict] - rank[b.verdict] || b.total - a.total)
        this.freshFetchedAt = Date.now()
        this.freshError = ''
      } catch (err) {
        this.freshError = err instanceof Error ? err.message : String(err)
        console.warn(`[${ERROR_CODES.DEX_FETCH_FAILED}] 新規上場リスト取得失敗: ${this.freshError}`)
      } finally {
        this.freshLoading = false
      }
    },
    /** フォールバック: ブラウザ直接取得（mint 権限・再発行照合は未取得=null になる） */
    async _fetchFreshDirect(): Promise<{ token: SolanaToken; signals: FreshTokenSignals }[]> {
      const discovered = await discoverFreshPairs(async <T>(url: string): Promise<T> => {
        const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
        if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`)
        return (await res.json()) as T
      }, SNIPE_MAX_AGE_HOURS)
      return discovered.map(({ pair, token, profile }) => {
        const h24 = pair.txns?.h24
        return {
          token,
          signals: {
            ...extractSnsSignals(pair.info, profile?.links),
            mintAuthorityRenounced: null,
            freezeAuthorityAbsent: null,
            duplicateCount: null,
            buys24h: h24?.buys ?? 0,
            sells24h: h24?.sells ?? 0,
          },
        }
      })
    },
    /** セッション開始。ladder/snipe は即時等分エントリー、ai はティックごとに判断 */
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
        this.ladderRules =
          method === 'snipe' ? [...SNIPE_LADDER_RULES] : [...DEFAULT_LADDER_RULES]
        this.positionMeta = {}

        if (method !== 'ai') {
          // ラダー/スナイプ方式: 割当資金を等分して即時エントリーし、以後は出口ルールのみ実行
          const strategyName = method === 'snipe' ? '新規上場スナイプ' : 'ラダーロジック'
          const perToken = allocatedUsd / pairAddresses.length
          for (const addr of pairAddresses) {
            const token = this.tokenOf(addr)
            if (!token || token.priceUsd <= 0) continue
            const result = executeOrder(this.portfolio, {
              assetId: addr,
              side: 'buy',
              notionalUsd: perToken,
              priceUsd: token.priceUsd,
              reason:
                method === 'snipe'
                  ? `スナイプ戦略の初期エントリー（新規上場 ${token.baseSymbol} へ等分投入）`
                  : `ラダー戦略の初期エントリー（${token.baseSymbol} へ等分投入）`,
              strategy: strategyName,
            })
            this.portfolio = result.portfolio
            this.positionMeta[addr] = { entryPriceUsd: token.priceUsd, triggered: [] }
          }
        }

        this.startTicking()
        this._persist()
        const label =
          method === 'ladder' ? 'ラダーロジック' : method === 'snipe' ? '新規上場スナイプ' : 'AI 取引'
        ui.notify(`魔界トレードを開始しました（${label} / $${allocatedUsd.toLocaleString()}）`)
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
      // 履歴表示用にシンボル対応を保存する（トークンリスト変動後も解決できるように）
      const symbols: Record<string, string> = {}
      for (const order of this.portfolio.orders) {
        const token = this.tokenOf(order.assetId)
        if (token) symbols[order.assetId] = token.baseSymbol
      }
      const tokenSymbols = this.watchedPairs.map(
        (a) => this.tokenOf(a)?.baseSymbol ?? a.slice(0, 6),
      )
      this.archives.unshift({
        endedAt: Date.now(),
        summary: summarize(this.portfolio, this.priceMap),
        method: this.method,
        tokenSymbols,
        orders: this.portfolio.orders.slice(-ARCHIVE_ORDERS_MAX),
        symbols,
      })
      // 容量保護: 古いアーカイブは約定明細を落としてサマリーのみ残す（原則2: 記録は保護）
      this.archives = this.archives
        .slice(0, 20)
        .map((a, i) => (i < ARCHIVE_ORDERS_KEEP ? a : { ...a, orders: undefined }))
      this._session++
      this.portfolio = null
      this.positionMeta = {}
    },
    endSession() {
      this.stop()
      this.archiveCurrent()
      this._persist()
      useUiStore().notify('魔界トレードのセッションを終了し、結果を過去セッションに保存しました')
    },
    async tick() {
      if (this.ticking || !this.running || !this.portfolio) return
      this.ticking = true
      const session = this._session
      try {
        await this.fetchTokens()
        // await 中にセッションが終了/再開始されていたら旧判断を執行しない（ISSUE-3）
        if (this._session !== session || !this.running || !this.portfolio) return
        const strategy = useStrategyStore().docFor('solana')
        const prices = this.priceMap

        for (const addr of [...this.watchedPairs]) {
          if (!this.portfolio) break
          const token = this.tokenOf(addr)
          if (!token || token.priceUsd <= 0) continue
          const pos = positionOf(this.portfolio, addr)

          if (this.method !== 'ai') {
            // ラダー/スナイプ: エントリー価格基準の出口ルールを機械的に執行
            if (!pos) continue
            const meta = this.positionMeta[addr]
            if (!meta) continue
            const strategyName = this.method === 'snipe' ? '新規上場スナイプ' : 'ラダーロジック'
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
                  strategy: strategyName,
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

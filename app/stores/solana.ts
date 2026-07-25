import { defineStore } from 'pinia'
import { decideDegenTrade } from '~/shared/degenAdvisor'
import {
  DEX_PAIRS_URL,
  discoverFreshPairs,
  discoverScreeningPairs,
  extractSnsSignals,
  isValidAddress,
  toToken,
  type DexPair,
} from '~/shared/dexscreener'
import { ERROR_CODES, formatError } from '~/shared/errors'
import { mockSolanaTokens } from '~/shared/mockData'
import {
  FRESH_DISPLAY_MAX,
  mergeFreshPool,
  passesMinimalAudit,
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

export type DegenMethod = 'ai' | 'ladder' | 'snipe' | 'auto-snipe'

export const DEGEN_METHOD_LABELS: Record<DegenMethod, string> = {
  ladder: 'ラダー',
  ai: 'AI 取引',
  snipe: 'スナイプ',
  'auto-snipe': '自動スナイプ',
}

/** 自動スナイプ（常時監視）の設定 */
export interface AutoSnipeConfig {
  /** 最大同時ポジション数（1 枠あたり予算 = 割当資金 / 本値） */
  maxPositions: number
  /** true = 監査で「要注意」判定も許容する（既定は「候補」のみ） */
  allowCaution: boolean
}

export const DEFAULT_AUTO_SNIPE: AutoSnipeConfig = { maxPositions: 5, allowCaution: false }

/** 自動スナイプ設定の正規化（開始時・復元時の両方で同じクランプを通す） */
export function normalizeAutoSnipe(cfg?: Partial<AutoSnipeConfig>): AutoSnipeConfig {
  const raw = Number(cfg?.maxPositions)
  return {
    maxPositions: Number.isFinite(raw)
      ? Math.min(10, Math.max(1, Math.round(raw)))
      : DEFAULT_AUTO_SNIPE.maxPositions,
    allowCaution: cfg?.allowCaution === true,
  }
}

/** 自動スナイプ: 監視データがこの時間より古い場合は新規エントリーを見送る */
const AUTO_SNIPE_MAX_DATA_AGE_MS = 5 * 60 * 1000
/** 自動スナイプ: これ未満の残余予算ではエントリーしない */
const AUTO_SNIPE_MIN_ENTRY_USD = 10

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
  /** 自動スナイプの設定・エントリー済みペア/ミント（追加フィールド: 旧データは既定値で復元） */
  autoSnipe?: AutoSnipeConfig
  enteredPairs?: string[]
  enteredMints?: string[]
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
    /**
     * 新規上場ハンター: ローリング監視プール（固定スナップショットではなく蓄積型）。
     * 新規発行トークンを随時追加し、48h 窓・上限 FRESH_POOL_MAX で保持する。
     * おすすめ順ソート済み。表示は上位 FRESH_DISPLAY_MAX 件（freshDisplay getter）
     */
    freshTokens: [] as SnipeScore[],
    /** 各プールエントリーを発見フィードで最後に確認した時刻（経時失効判定用） */
    freshSeenAt: {} as Record<string, number>,
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
    /** 自動スナイプの設定 */
    autoSnipe: { ...DEFAULT_AUTO_SNIPE } as AutoSnipeConfig,
    /** 自動スナイプで既にエントリーしたペア（全決済後の再エントリーを防ぐ） */
    enteredPairs: [] as string[],
    /**
     * エントリー済みミント（トークン単位の再エントリー防止）。
     * 代表プールが移り変わっても同一トークンへの二重エントリーを防ぐ
     */
    enteredMints: [] as string[],
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
    /** 画面表示用: 監視プールのおすすめ上位（監視自体はプール全体で継続する） */
    freshDisplay(state): SnipeScore[] {
      return state.freshTokens.slice(0, FRESH_DISPLAY_MAX)
    },
    /** 自動スナイプ: 現在の監査基準を通過している新規上場トークン数（監視ステータス表示用） */
    freshAuditPassedCount(state): number {
      return state.freshTokens.filter((s) =>
        passesMinimalAudit(s, { allowCaution: state.autoSnipe.allowCaution }),
      ).length
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
        // 復元時も開始時と同じクランプを通す（別バージョン・改変データへの防御）
        this.autoSnipe = saved.autoSnipe ? normalizeAutoSnipe(saved.autoSnipe) : { ...DEFAULT_AUTO_SNIPE }
        this.enteredPairs = saved.enteredPairs ?? []
        this.enteredMints = saved.enteredMints ?? []
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
        autoSnipe: { ...this.autoSnipe },
        enteredPairs: [...this.enteredPairs],
        enteredMints: [...this.enteredMints],
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
    /** ペア群 → 表示用トークンリスト（メジャーペア除外）への変換 */
    _parseScreenPairs(pairs: DexPair[]): SolanaToken[] {
      return pairs
        .map(toToken)
        .filter((t): t is SolanaToken => t !== null)
        // SOL/USDC 等のメジャーペア自体は除外し、新興トークン側に絞る
        .filter((t) => !['SOL', 'WSOL', 'USDC', 'USDT'].includes(t.baseSymbol.toUpperCase()))
    },
    async fetchTokens(force = false) {
      this.loading = this.tokens.length === 0 || (force && this.usingMockData)
      if (force) this._dexVia = 'direct'
      try {
        let tokens: SolanaToken[] = []
        // 経路の成否は「使えるトークンが得られたか」で判定する。企業ネットワーク等では
        // 直接取得が HTTP 200 のまま空・改変応答を返すことがあり、トランスポート成功
        // だけで判定するとプロキシへ切り替わらない（本番障害 CRYPTIA-E102 の実例）
        if (this._dexVia === 'direct') {
          try {
            const pairs = await discoverScreeningPairs(async <T>(url: string): Promise<T> => {
              const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
              if (!res.ok) throw new Error(`DexScreener HTTP ${res.status}`)
              return (await res.json()) as T
            })
            tokens = this._parseScreenPairs(pairs)
          } catch {
            tokens = []
          }
          if (tokens.length === 0) this._dexVia = 'proxy'
        }
        if (tokens.length === 0) {
          try {
            const data = await $fetch<{ pairs?: DexPair[] }>('/api/solana/screen', {
              timeout: 25_000,
            })
            tokens = this._parseScreenPairs(data.pairs ?? [])
          } catch (err) {
            this._dexVia = 'direct'
            throw err
          }
        }
        if (tokens.length === 0) {
          // プロキシ応答も内容 0 件 = 上流全体の劣化。次回は直接から再試行する（自己回復）
          this._dexVia = 'direct'
          throw new Error('DexScreener の応答に Solana ペアがありません')
        }
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
      // pairs API の 30 件制約に対し保有ポジションを優先する
      // （watchedPairs が多い場合でも現役ポジションの価格が必ず更新される: ISSUE-P9-M5）
      const targets: string[] = this.portfolio.positions.map((p) => p.assetId)
      for (const addr of this.watchedPairs) {
        if (!targets.includes(addr)) targets.push(addr)
      }
      const addrs = targets.filter(isValidAddress).slice(0, 30)
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
        // ローリング監視プールへマージ（新規発行を随時追加・既知は最新情報へ置換・48h窓で失効）
        const now = Date.now()
        const incoming = items.map((i) => scoreFreshToken(i.token, i.signals))
        const pool = mergeFreshPool(
          this.freshTokens.map((score) => ({
            score,
            lastSeenAt: this.freshSeenAt[score.token.pairAddress] ?? now,
          })),
          incoming,
          now,
        )
        this.freshTokens = pool.map((e) => e.score)
        this.freshSeenAt = Object.fromEntries(
          pool.map((e) => [e.score.token.pairAddress, e.lastSeenAt]),
        )
        this.freshFetchedAt = now
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
    /**
     * セッション開始。ladder/snipe は即時等分エントリー、ai はティックごとに判断、
     * auto-snipe は選択不要 — 常時監視で監査通過トークンへ随時エントリーする。
     */
    async start(
      allocatedUsd: number,
      pairAddresses: string[],
      method: DegenMethod,
      autoConfig?: Partial<AutoSnipeConfig>,
    ) {
      const ui = useUiStore()
      if (this.running) {
        ui.notify('魔界トレードは既に実行中です', 'warn')
        return
      }
      if (method !== 'auto-snipe' && pairAddresses.length === 0) {
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
          method === 'snipe' || method === 'auto-snipe'
            ? [...SNIPE_LADDER_RULES]
            : [...DEFAULT_LADDER_RULES]
        this.positionMeta = {}
        this.enteredPairs = []
        this.enteredMints = []
        if (method === 'auto-snipe') this.autoSnipe = normalizeAutoSnipe(autoConfig)

        if (method === 'ladder' || method === 'snipe') {
          // 執行直前に選択ペアの最新価格を取得してからエントリーする
          // （スナイプはローリングプール由来で価格が古い場合があるため。
          //   watchedPairs は設定済みのため refreshDisplayPrices が選択ペアを更新する）
          await this.refreshDisplayPrices()
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
          method === 'ladder'
            ? 'ラダーロジック'
            : method === 'snipe'
              ? '新規上場スナイプ'
              : method === 'auto-snipe'
                ? '自動スナイプ（常時監視）'
                : 'AI 取引'
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
    /**
     * 自動スナイプ: 全量決済済みペアを監視対象から外す。
     * pairs API の 30 件制約の枠を現役ポジションのために温存する
     * （再エントリーの禁止は enteredPairs が別途担うため、剪定しても安全）。
     * 照合対象（新規上場 48h 窓）に現れ得ない古いエントリー履歴も上限で間引く。
     */
    _pruneClosedAutoPairs() {
      if (this.method !== 'auto-snipe' || !this.portfolio) return
      this.watchedPairs = this.watchedPairs.filter(
        (addr) => positionOf(this.portfolio!, addr) !== undefined,
      )
      for (const addr of Object.keys(this.positionMeta)) {
        if (!this.watchedPairs.includes(addr)) delete this.positionMeta[addr]
      }
      if (this.enteredPairs.length > 200) this.enteredPairs = this.enteredPairs.slice(-200)
      if (this.enteredMints.length > 200) this.enteredMints = this.enteredMints.slice(-200)
    },
    /**
     * 自動スナイプ（常時監視）の新規エントリー処理。
     * 新規上場リストを更新し、最低限の監査（passesMinimalAudit）を通過した
     * トークンへ、空き枠がある限り等分予算でエントリーする。
     * 一度エントリーしたペアには再エントリーしない（ラグ後の再急騰への誘い込み対策）。
     */
    async _autoSnipeEntries(session: number) {
      await this.fetchFreshTokens()
      if (this._session !== session || !this.running || !this.portfolio) return
      // 参考データ（モック）や古い監視データでは実勢と乖離するためエントリーしない
      if (this.usingMockData) return
      if (Date.now() - this.freshFetchedAt > AUTO_SNIPE_MAX_DATA_AGE_MS) return

      const openPositions = this.portfolio.positions.length
      const slots = Math.max(0, this.autoSnipe.maxPositions - openPositions)
      if (slots === 0) return
      const perSlot = this.portfolio.initialUsd / this.autoSnipe.maxPositions

      // 1) 監査通過・未エントリーの候補を空き枠の数だけ確定する。
      //    ローリングプールにはフィード落ちした古い情報のエントリーも残るため、
      //    **発見フィードで 5 分以内に確認できたエントリーのみ**を執行対象にする
      //    （古い流動性・判定で監査を通過してエントリーする経路の遮断）
      const now = Date.now()
      const candidates: SnipeScore[] = []
      for (const score of this.freshTokens) {
        if (candidates.length >= slots) break
        const addr = score.token.pairAddress
        if (now - (this.freshSeenAt[addr] ?? this.freshFetchedAt) > AUTO_SNIPE_MAX_DATA_AGE_MS) continue
        if (!passesMinimalAudit(score, { allowCaution: this.autoSnipe.allowCaution })) continue
        // 再エントリー防止はトークン（ミント）単位。代表プールの移り変わりでも二重エントリーしない
        if (this.enteredMints.includes(score.token.baseAddress)) continue
        if (this.enteredPairs.includes(addr)) continue
        if (positionOf(this.portfolio, addr)) continue
        candidates.push(score)
      }
      if (candidates.length === 0) return

      // 2) 執行直前に候補の価格を個別取得で最新化する（監視データは最大 2 分前のキャッシュのため）。
      //    取得失敗時は監視価格で継続（候補は上の確認 5 分以内ゲートで鮮度が有界。原則4: 劣化継続）
      try {
        const addrs = candidates.map((s) => s.token.pairAddress).filter(isValidAddress)
        const data = await this._fetchDex<{ pairs?: DexPair[] }>(
          `${DEX_PAIRS_URL}${addrs.join(',')}`,
          `/api/solana/pairs?addrs=${addrs.join(',')}`,
        )
        const priceByPair = new Map<string, number>()
        for (const p of data.pairs ?? []) {
          const token = toToken(p)
          if (token) priceByPair.set(token.pairAddress, token.priceUsd)
        }
        for (const s of candidates) {
          const price = priceByPair.get(s.token.pairAddress)
          if (price) s.token.priceUsd = price
        }
      } catch {
        /* 直前価格の取得失敗は監視価格で継続 */
      }
      if (this._session !== session || !this.running || !this.portfolio) return

      // 3) エントリー実行
      for (const score of candidates) {
        if (!this.portfolio) break
        const addr = score.token.pairAddress
        const notionalUsd = Math.min(perSlot, this.portfolio.cashUsd)
        if (notionalUsd < AUTO_SNIPE_MIN_ENTRY_USD) break
        if (score.token.priceUsd <= 0) continue
        try {
          const result = executeOrder(this.portfolio, {
            assetId: addr,
            side: 'buy',
            notionalUsd,
            priceUsd: score.token.priceUsd,
            reason: `自動スナイプ: 監査通過（スコア ${score.total}・${score.verdict === 'candidate' ? '候補' : '要注意'}）の新規上場 ${score.token.baseSymbol} へエントリー`,
            strategy: '自動スナイプ',
          })
          this.portfolio = result.portfolio
          this.positionMeta[addr] = { entryPriceUsd: score.token.priceUsd, triggered: [] }
          this.enteredPairs.push(addr)
          this.enteredMints.push(score.token.baseAddress)
          if (!this.watchedPairs.includes(addr)) this.watchedPairs.push(addr)
        } catch (err) {
          // 資金不足等は記録して継続（原則4）
          const { code, message } = formatError(err)
          console.warn(`[${code}] ${message}`)
        }
      }
    },
    async tick() {
      if (this.ticking || !this.running || !this.portfolio) return
      this.ticking = true
      const session = this._session
      try {
        await this.fetchTokens()
        // await 中にセッションが終了/再開始されていたら旧判断を執行しない（ISSUE-3）
        if (this._session !== session || !this.running || !this.portfolio) return

        // 自動スナイプ: 監視 → 監査 → 随時エントリー（出口は下のラダー共通処理）
        if (this.method === 'auto-snipe') {
          await this._autoSnipeEntries(session)
          if (this._session !== session || !this.running || !this.portfolio) return
        }

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
            const strategyName =
              this.method === 'snipe'
                ? '新規上場スナイプ'
                : this.method === 'auto-snipe'
                  ? '自動スナイプ'
                  : 'ラダーロジック'
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

        // 自動スナイプ: 全量決済済みペアの監視を剪定（価格取得 30 件枠の温存: ISSUE-P9-M5）
        if (this.method === 'auto-snipe') this._pruneClosedAutoPairs()

        if (this.portfolio) this.portfolio = recordEquity(this.portfolio, this.priceMap)
        this._persist()
      } finally {
        this.ticking = false
      }
    },
  },
})

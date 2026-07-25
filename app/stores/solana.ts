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
  buildMoonbagLadder,
  FRESH_DISPLAY_MAX,
  mergeFreshPool,
  MOONBAG_DEFAULT_STOP_LOSS_PCT,
  normalizeMoonbagStopLoss,
  passesMinimalAudit,
  scoreFreshToken,
  SNIPE_LADDER_RULES,
  SNIPE_MAX_AGE_HOURS,
  type FreshTokenSignals,
  type SnipeScore,
} from '~/shared/snipeScoring'
import { fitArchivesToBudget, fitSessionsToBudget, utf8Bytes } from '~/shared/persistBudget'
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
/** 同時に持てるセッション数の上限（価格取得 30 件枠・UI の複雑性の抑制） */
export const MAX_DEGEN_SESSIONS = 3
/**
 * AI 手法のセッション×ペアの合計上限。30s ティック = 2 回/分のため
 * 6 ペアで最大 12 回/分。AI API のレートリミット（uid 単位 40/分）は
 * デモトレードの AI エンジン（最大 24 回/分）・市場インサイト・実トレードの
 * 手動 AI 判断と**共有**のため、自動枠の合算 36 回/分 + 手動系の余裕
 * 4 回/分 で 40/分内に収める（ISSUE-P9-M13）
 */
export const MAX_AI_PAIRS_TOTAL = 6
/**
 * 1 セッションの選択ペア上限。3 セッション × 10 = 30 で価格取得の
 * 30 件バッチ制約に収まる（超過時は後方セッションの価格が凍結する: ISSUE-P9-L28）
 */
export const MAX_PAIRS_PER_SESSION = 10
/** アーカイブ1件に保存する約定履歴の上限（Firestore ドキュメント容量保護） */
const ARCHIVE_ORDERS_MAX = 100
/** 約定履歴を保持するアーカイブ数（それより古いものはサマリーのみ残す） */
const ARCHIVE_ORDERS_KEEP = 10

export type DegenMethod = 'ai' | 'ladder' | 'snipe' | 'auto-snipe' | 'moonbag'

export const DEGEN_METHOD_LABELS: Record<DegenMethod, string> = {
  ladder: 'ラダー',
  ai: 'AI 取引',
  snipe: 'スナイプ',
  'auto-snipe': '自動スナイプ',
  moonbag: 'ムーンバッグ',
}

/**
 * 常時監視エントリー（自動スナイプ系パイプライン）を使う手法か。
 * true の手法はトークン選択不要 — 新規上場プールの監査通過トークンへ随時エントリーする。
 * 出口だけが異なる: auto-snipe = 利益確保型ラダー / moonbag = +100% で 70% 売却 → 残り恒久保持
 */
export function usesAutoPipeline(m: DegenMethod): boolean {
  return m === 'auto-snipe' || m === 'moonbag'
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
  /**
   * ムーンバッグ化した時刻（+100% 利確発動でセット）。
   * セット後は損切り含む全ルールが無効（完全放置）で、
   * 同時ポジション数にも数えない（新規エントリー枠を塞がない）
   */
  moonbagAt?: number
  /**
   * 保有トークンのミント（baseAddress）。エントリー履歴（enteredMints）の
   * 200 件間引きから独立して「現在保有中のミント」を照合できるようにする
   * （長期運用で履歴から消えた保有中トークンの別プールへの再エントリー防止:
   * ISSUE-P9-M14。旧データは未設定 = tokenOf からのフォールバック解決）
   */
  mint?: string
}

/** 魔界トレードのセッション（複数同時実行可能: F-05/F-06） */
export interface DegenSession {
  id: string
  name: string
  createdAt: number
  portfolio: Portfolio
  running: boolean
  method: DegenMethod
  ladderRules: LadderRule[]
  watchedPairs: string[]
  positionMeta: Record<string, PositionMeta>
  autoSnipe: AutoSnipeConfig
  enteredPairs: string[]
  enteredMints: string[]
  /** AI 判断がレートリミット等でロジックへ縮退した最終時刻（UI で明示する） */
  aiDegradedAt?: number
  /**
   * ムーンバッグ手法の損切りライン（%・負値）。null = 損切りなし（完全放置）。
   * +100% 到達前のみ有効（到達後はムーンバッグ化して全ルール無効）。
   * moonbag 以外の手法では undefined
   */
  moonbagStopLossPct?: number | null
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
  /** セッション名（複数セッション対応後の追加フィールド） */
  name?: string
}

/** 旧形式（単一セッション）を含む永続化ペイロード */
interface PersistedDegen {
  sessions?: DegenSession[]
  /** セッション既定名の通し番号（途中終了で番号が重複しないよう永続化） */
  sessionCounter?: number
  archives: DegenArchive[]
  /** 旧形式（v1: 単一セッション）。移行用に残す（原則7） */
  portfolio?: Portfolio | null
  running?: boolean
  method?: DegenMethod
  ladderRules?: LadderRule[]
  watchedPairs?: string[]
  positionMeta?: Record<string, PositionMeta>
  autoSnipe?: AutoSnipeConfig
  enteredPairs?: string[]
  enteredMints?: string[]
}

let sessionSeq = 0
function newSessionId(): string {
  return `degen-${Date.now().toString(36)}-${++sessionSeq}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * ムーンバッグの価格更新ローテーション位置（表示専用のためメモリのみ）。
 * ムーンバッグは売却ルールなし = 価格が執行に影響しないため優先度を下げ、
 * pairs API の 30 件枠に収まらない分は呼び出しごとに 1 つずつ窓をずらして
 * 順繰りに更新する（全ムーンバッグの評価額がいずれ更新される）
 */
let moonbagPriceRotation = 0

/**
 * Solana 魔界トレードストア（UC-5 / F-05, F-06）。
 * - **複数セッションを同時実行**できる（それぞれ独立した資金・手法・実行状態）
 * - 市場データ（スクリーニング・監視プール・価格）は全セッションで共有し、
 *   ティックはストアで一本化して実行中の全セッションを順に処理する（API 負荷は一定）
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
    /** 実行中・一時停止中のセッション一覧（複数同時実行可能） */
    sessions: [] as DegenSession[],
    /** セッション既定名の通し番号（重複防止のため永続化） */
    sessionCounter: 0,
    archives: [] as DegenArchive[],
    ticking: false,
    restored: false,
    _timer: null as ReturnType<typeof setInterval> | null,
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
    /** 監査基準を通過している新規上場トークン数（監視ステータス表示用） */
    freshAuditPassedCount(state) {
      return (allowCaution: boolean): number =>
        state.freshTokens.filter((s) => passesMinimalAudit(s, { allowCaution })).length
    },
    sessionById: (state) => (id: string) => state.sessions.find((s) => s.id === id),
    anyRunning: (state) => state.sessions.some((s) => s.running),
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
    summaryOf() {
      return (id: string): PortfolioSummary | null => {
        const session = this.sessionById(id)
        if (!session) return null
        return summarize(session.portfolio, this.priceMap)
      }
    },
    /** ムーンバッグ保有の集計（件数・評価額）。moonbag 手法以外は常に 0 件 */
    moonbagStatsOf() {
      return (id: string): { count: number; valueUsd: number } => {
        const session = this.sessionById(id)
        if (!session || session.method !== 'moonbag') return { count: 0, valueUsd: 0 }
        let count = 0
        let valueUsd = 0
        for (const p of session.portfolio.positions) {
          if (!session.positionMeta[p.assetId]?.moonbagAt) continue
          count++
          valueUsd += p.quantity * (this.tokenOf(p.assetId)?.priceUsd ?? p.avgCostUsd)
        }
        return { count, valueUsd }
      }
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const saved = await restore<PersistedDegen>(STORE_KEY)
      if (saved) {
        this.archives = saved.archives ?? []
        this.sessionCounter = saved.sessionCounter ?? 0
        if (saved.sessions) {
          this.sessions = saved.sessions.map((s) => {
            // 復元時も開始時と同じクランプを通す（別バージョン・改変データへの防御）
            const moonbagStopLossPct =
              s.method === 'moonbag' ? normalizeMoonbagStopLoss(s.moonbagStopLossPct) : undefined
            return {
              ...s,
              autoSnipe: normalizeAutoSnipe(s.autoSnipe),
              moonbagStopLossPct,
              // moonbag はルール構成が設定から一意に決まるため再構築し、
              // 設定（moonbagStopLossPct）と実行ルールの乖離を防ぐ
              ladderRules:
                s.method === 'moonbag'
                  ? buildMoonbagLadder(moonbagStopLossPct ?? null)
                  : s.ladderRules,
            }
          })
        } else if (saved.portfolio) {
          // 旧形式（単一セッション）からの移行（原則7: 下位互換）
          this.sessions = [
            {
              id: newSessionId(),
              name: 'セッション 1',
              createdAt: Date.now(),
              portfolio: saved.portfolio,
              running: saved.running ?? false,
              method: saved.method ?? 'ladder',
              ladderRules: saved.ladderRules?.length
                ? saved.ladderRules
                : [...DEFAULT_LADDER_RULES],
              watchedPairs: saved.watchedPairs ?? [],
              positionMeta: saved.positionMeta ?? {},
              autoSnipe: saved.autoSnipe
                ? normalizeAutoSnipe(saved.autoSnipe)
                : { ...DEFAULT_AUTO_SNIPE },
              enteredPairs: saved.enteredPairs ?? [],
              enteredMints: saved.enteredMints ?? [],
            },
          ]
        }
        // 再訪時、実行中セッションは自動再開する（手動ステップを残さない: 原則1）
        if (this.anyRunning) this.startTicking()
      }
      this.restored = true
    },
    _persist() {
      const payload: PersistedDegen = {
        sessions: JSON.parse(JSON.stringify(this.sessions)),
        sessionCounter: this.sessionCounter,
        archives: JSON.parse(JSON.stringify(this.archives)),
      }
      // Firestore ドキュメント上限（256KB）に収まることを実測で保証する（AUDIT-P9-1）。
      // 先に実行中セッションの永続化コピーを絞り、アーカイブ（保護対象の記録: BR-7）を温存する
      payload.sessions = fitSessionsToBudget(payload.sessions!, (s) =>
        utf8Bytes(JSON.stringify({ ...payload, sessions: s })),
      )
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
    /** 全セッションの監視ペア（watchedPairs）の集合 */
    _allWatchedPairs(): string[] {
      const out: string[] = []
      for (const session of this.sessions) {
        for (const addr of session.watchedPairs) {
          if (!out.includes(addr)) out.push(addr)
        }
      }
      return out
    },
    /**
     * 価格更新の対象リスト（優先順・30 件枠へ切る前の全体）。
     * アクティブな保有（出口ルールが生きている = 価格が執行に直結）を最優先し、
     * ムーンバッグ（売却ルールなし = 表示専用）→ その他の監視ペアの順で詰める。
     * 分類は**全セッション横断**で行う — 同一ペアを複数セッションが保有し得るため、
     * 1 つでもアクティブに保有するセッションがあればアクティブ扱いにする
     * （ムーンバッグセッションの評価順が先でも執行用の価格鮮度を劣化させない: ISSUE-P9-M15）。
     * ムーンバッグは恒久保持で件数が増え続けるため、枠に収まらない分は
     * 呼び出しごとのローテーションで順繰りに更新する。
     */
    _priceRefreshTargets(): string[] {
      const activeSet = new Set<string>()
      const moonbagSet = new Set<string>()
      for (const session of this.sessions) {
        for (const p of session.portfolio.positions) {
          if (session.positionMeta[p.assetId]?.moonbagAt) moonbagSet.add(p.assetId)
          else activeSet.add(p.assetId)
        }
      }
      const active = [...activeSet]
      const moonbags = [...moonbagSet].filter((addr) => !activeSet.has(addr))
      if (moonbags.length > 1) {
        const offset = moonbagPriceRotation % moonbags.length
        moonbagPriceRotation = (moonbagPriceRotation + 1) % 1_000_000
        moonbags.splice(0, moonbags.length, ...moonbags.slice(offset), ...moonbags.slice(0, offset))
      }
      const targets = [...active, ...moonbags]
      for (const addr of this._allWatchedPairs()) {
        if (!targets.includes(addr)) targets.push(addr)
      }
      return targets.filter(isValidAddress)
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
        const watched = this._allWatchedPairs()
        const held = this.tokens.filter(
          (t) => watched.includes(t.pairAddress) && !tokens.some((n) => n.pairAddress === t.pairAddress),
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
     * 全セッションの保有ポジションを優先し、pairs API の 30 件制約に収める。
     * 呼び出し元は 2 系統:
     *   - tick()（30s・バックグラウンドでも実行）: 検索リスト外ペアの凍結価格防止（ISSUE-P9-H1）
     *   - 画面の表示タイマー（10s）: 一時停止中・復元直後の損益リアルタイム表示
     */
    async refreshDisplayPrices() {
      if (this._pricesBusy || this.usingMockData) return
      // セッションなしの間は無駄な取得をしない（クォータ浪費防止）
      if (this.sessions.length === 0) return
      const addrs = this._priceRefreshTargets().slice(0, 30)
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
     * 新しいセッションを開始する（既存セッションは動かしたまま追加できる）。
     * ladder/snipe は即時等分エントリー、ai はティックごとに判断、
     * auto-snipe / moonbag は選択不要 — 常時監視で監査通過トークンへ随時エントリーする
     * （moonbag の出口は +100% で 70% 売却 → 残りは売却ルールなしで恒久保持）。
     */
    async start(
      allocatedUsd: number,
      pairAddresses: string[],
      method: DegenMethod,
      autoConfig?: Partial<AutoSnipeConfig>,
      name = '',
      // 引数省略時は推奨の -50%。損切りなし（完全放置）は null の明示指定のみ
      moonbagStopLossPct: number | null = MOONBAG_DEFAULT_STOP_LOSS_PCT,
    ) {
      const ui = useUiStore()
      if (this.sessions.length >= MAX_DEGEN_SESSIONS) {
        ui.notify(`同時に実行できるセッションは ${MAX_DEGEN_SESSIONS} 件までです。不要なセッションを終了してください`, 'warn')
        return
      }
      if (!usesAutoPipeline(method) && pairAddresses.length === 0) {
        ui.notify('取引対象のトークンを選択してください', 'warn')
        return
      }
      // 価格取得 30 件バッチに全セッションの保有が収まるよう 1 セッションの選択数を制限
      if (pairAddresses.length > MAX_PAIRS_PER_SESSION) {
        ui.notify(`1 セッションで選択できるトークンは ${MAX_PAIRS_PER_SESSION} 件までです`, 'warn')
        return
      }
      // AI 判断 API のレートリミット内に収める合計上限（サイレント縮退の防止）
      if (method === 'ai') {
        const aiPairsTotal =
          this.sessions
            .filter((s) => s.method === 'ai')
            .reduce((sum, s) => sum + s.watchedPairs.length, 0) + pairAddresses.length
        if (aiPairsTotal > MAX_AI_PAIRS_TOTAL) {
          ui.notify(
            `AI 取引の合計トークン数は ${MAX_AI_PAIRS_TOTAL} までです（AI 判断 API の混雑防止）。対象を減らすか、ラダー系の手法をご利用ください`,
            'warn',
          )
          return
        }
      }
      try {
        const normalizedStopLoss =
          method === 'moonbag' ? normalizeMoonbagStopLoss(moonbagStopLossPct) : undefined
        const session: DegenSession = {
          id: newSessionId(),
          name:
            name.trim().slice(0, 30) ||
            `${DEGEN_METHOD_LABELS[method]} ${++this.sessionCounter}`,
          createdAt: Date.now(),
          portfolio: createPortfolio(allocatedUsd),
          running: true,
          method,
          ladderRules:
            method === 'moonbag'
              ? buildMoonbagLadder(normalizedStopLoss ?? null)
              : method === 'snipe' || method === 'auto-snipe'
                ? [...SNIPE_LADDER_RULES]
                : [...DEFAULT_LADDER_RULES],
          watchedPairs: [...pairAddresses],
          positionMeta: {},
          autoSnipe: normalizeAutoSnipe(autoConfig),
          enteredPairs: [],
          enteredMints: [],
          moonbagStopLossPct: normalizedStopLoss,
        }
        this.sessions.push(session)

        if (method === 'ladder' || method === 'snipe') {
          // 執行直前に選択ペアの最新価格を取得してからエントリーする
          // （スナイプはローリングプール由来で価格が古い場合があるため）
          await this.refreshDisplayPrices()
          const target = this.sessionById(session.id)
          if (!target) return
          // ラダー/スナイプ方式: 割当資金を等分して即時エントリーし、以後は出口ルールのみ実行
          const strategyName = method === 'snipe' ? '新規上場スナイプ' : 'ラダーロジック'
          const perToken = allocatedUsd / pairAddresses.length
          for (const addr of pairAddresses) {
            const token = this.tokenOf(addr)
            if (!token || token.priceUsd <= 0) continue
            const result = executeOrder(target.portfolio, {
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
            target.portfolio = result.portfolio
            target.positionMeta[addr] = {
              entryPriceUsd: token.priceUsd,
              triggered: [],
              mint: token.baseAddress,
            }
          }
        }

        this.startTicking()
        this._persist()
        ui.notify(`「${session.name}」を開始しました（$${allocatedUsd.toLocaleString()}）`)
      } catch (err) {
        const { code, message } = formatError(err)
        ui.notify(message, 'error', code)
      }
    },
    startTicking() {
      if (this._timer) return
      // 再開状態を即時永続化する（リロードで停止状態に巻き戻さない: 原則2）
      this._persist()
      this._timer = setInterval(() => void this.tick(), DEGEN_TICK_MS)
      void this.tick()
    },
    _stopTimerIfIdle() {
      if (!this.anyRunning && this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
    },
    pause(id: string) {
      const session = this.sessionById(id)
      if (!session) return
      session.running = false
      this._stopTimerIfIdle()
      this._persist()
    },
    resume(id: string) {
      const session = this.sessionById(id)
      if (!session) return
      session.running = true
      this.startTicking()
      this._persist()
    },
    /** セッション終了（アーカイブへ退避して一覧から除去。履歴は消さない） */
    endSession(id: string) {
      const session = this.sessionById(id)
      if (!session) return
      if (session.portfolio.orders.length > 0) {
        // 履歴表示用にシンボル対応を保存する（トークンリスト変動後も解決できるように）
        const symbols: Record<string, string> = {}
        for (const order of session.portfolio.orders) {
          const token = this.tokenOf(order.assetId)
          if (token) symbols[order.assetId] = token.baseSymbol
        }
        const tokenSymbols = session.watchedPairs.map(
          (a) => this.tokenOf(a)?.baseSymbol ?? a.slice(0, 6),
        )
        this.archives.unshift({
          endedAt: Date.now(),
          summary: summarize(session.portfolio, this.priceMap),
          method: session.method,
          tokenSymbols,
          orders: session.portfolio.orders.slice(-ARCHIVE_ORDERS_MAX),
          symbols,
          name: session.name,
        })
        // 容量保護: 古いアーカイブは約定明細を落としてサマリーのみ残す（原則2: 記録は保護）
        this.archives = this.archives
          .slice(0, 20)
          .map((a, i) => (i < ARCHIVE_ORDERS_KEEP ? a : { ...a, orders: undefined }))
      }
      this.sessions = this.sessions.filter((s) => s.id !== id)
      this._stopTimerIfIdle()
      this._persist()
      useUiStore().notify(`「${session.name}」を終了し、結果を過去セッションに保存しました`)
    },
    /** 現在保有中（ムーンバッグ含む）のミント集合。旧データは tokenOf からフォールバック解決 */
    _heldMints(session: DegenSession): Set<string> {
      const out = new Set<string>()
      for (const p of session.portfolio.positions) {
        const mint = session.positionMeta[p.assetId]?.mint ?? this.tokenOf(p.assetId)?.baseAddress
        if (mint) out.add(mint)
      }
      return out
    },
    /**
     * 自動スナイプ: 全量決済済みペアを監視対象から外す。
     * pairs API の 30 件制約の枠を現役ポジションのために温存する
     * （再エントリーの禁止は enteredPairs/enteredMints が別途担うため、剪定しても安全）。
     * 照合対象（新規上場 48h 窓）に現れ得ない古いエントリー履歴も上限で間引くが、
     * **保有中（ムーンバッグ含む）の分は保護する** — 恒久保持のムーンバッグセッションでは
     * 累計 200 件超過が現実的で、保有中トークンが履歴から消えると同一ミントの別プールへ
     * 再エントリーできてしまうため（ISSUE-P9-M14）。
     */
    _pruneClosedAutoPairs(session: DegenSession) {
      if (!usesAutoPipeline(session.method)) return
      session.watchedPairs = session.watchedPairs.filter(
        (addr) => positionOf(session.portfolio, addr) !== undefined,
      )
      for (const addr of Object.keys(session.positionMeta)) {
        if (!session.watchedPairs.includes(addr)) delete session.positionMeta[addr]
      }
      // 上限間引き（保有中の分は間引かない。保護分が上限を超える場合は保護のみ残す）
      const trimProtected = (list: string[], isProtected: (v: string) => boolean, cap: number) => {
        if (list.length <= cap) return list
        const room = cap - list.filter(isProtected).length
        // slice(-0) は全件残しになるため、空き枠なしは明示的に空集合（ISSUE-P9-L36）
        const keepOthers =
          room > 0 ? new Set(list.filter((v) => !isProtected(v)).slice(-room)) : new Set<string>()
        return list.filter((v) => isProtected(v) || keepOthers.has(v))
      }
      const heldMints = this._heldMints(session)
      session.enteredMints = trimProtected(session.enteredMints, (m) => heldMints.has(m), 200)
      session.enteredPairs = trimProtected(
        session.enteredPairs,
        (addr) => positionOf(session.portfolio, addr) !== undefined,
        200,
      )
    },
    /**
     * 自動スナイプ（常時監視）の新規エントリー処理。
     * 新規上場リストを更新し、最低限の監査（passesMinimalAudit）を通過した
     * トークンへ、空き枠がある限り等分予算でエントリーする。
     * 一度エントリーしたトークン（ミント単位）には再エントリーしない。
     */
    async _autoSnipeEntries(sessionId: string) {
      await this.fetchFreshTokens()
      let session = this.sessionById(sessionId)
      if (!session || !session.running) return
      // 参考データ（モック）や古い監視データでは実勢と乖離するためエントリーしない
      if (this.usingMockData) return
      if (Date.now() - this.freshFetchedAt > AUTO_SNIPE_MAX_DATA_AGE_MS) return

      // ムーンバッグ化した保有（売却ルールなし・利確済み）は同時ポジション数に数えない —
      // 恒久保持が新規エントリー枠を塞ぐと監視型戦略として機能停止するため（auto-snipe では常に全件が対象）
      // ※ 閉包へは const 参照を渡す（let の session は strict narrowing が効かない）
      const positionMeta = session.positionMeta
      const openPositions = session.portfolio.positions.filter(
        (p) => !positionMeta[p.assetId]?.moonbagAt,
      ).length
      const slots = Math.max(0, session.autoSnipe.maxPositions - openPositions)
      if (slots === 0) return
      const perSlot = session.portfolio.initialUsd / session.autoSnipe.maxPositions

      // 1) 監査通過・未エントリーの候補を空き枠の数だけ確定する。
      //    ローリングプールにはフィード落ちした古い情報のエントリーも残るため、
      //    **発見フィードで 5 分以内に確認できたエントリーのみ**を執行対象にする
      //    （古い流動性・判定で監査を通過してエントリーする経路の遮断）
      const now = Date.now()
      const heldMints = this._heldMints(session)
      const candidates: SnipeScore[] = []
      for (const score of this.freshTokens) {
        if (candidates.length >= slots) break
        const addr = score.token.pairAddress
        if (now - (this.freshSeenAt[addr] ?? this.freshFetchedAt) > AUTO_SNIPE_MAX_DATA_AGE_MS) continue
        if (!passesMinimalAudit(score, { allowCaution: session.autoSnipe.allowCaution })) continue
        // 再エントリー防止はトークン（ミント）単位。代表プールの移り変わりでも二重エントリーしない
        if (session.enteredMints.includes(score.token.baseAddress)) continue
        if (session.enteredPairs.includes(addr)) continue
        if (positionOf(session.portfolio, addr)) continue
        // 保有中（ムーンバッグ含む）ミントの別プールにも入らない（履歴間引き後の防衛: ISSUE-P9-M14）
        if (heldMints.has(score.token.baseAddress)) continue
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
      // await 中にセッションが終了/一時停止されていたら執行しない（ISSUE-3 と同水準）
      session = this.sessionById(sessionId)
      if (!session || !session.running) return

      // 3) エントリー実行
      for (const score of candidates) {
        const addr = score.token.pairAddress
        const notionalUsd = Math.min(perSlot, session.portfolio.cashUsd)
        if (notionalUsd < AUTO_SNIPE_MIN_ENTRY_USD) break
        if (score.token.priceUsd <= 0) continue
        try {
          const isMoonbag = session.method === 'moonbag'
          const result = executeOrder(session.portfolio, {
            assetId: addr,
            side: 'buy',
            notionalUsd,
            priceUsd: score.token.priceUsd,
            reason: `${isMoonbag ? 'ムーンバッグ戦略' : '自動スナイプ'}: 監査通過（スコア ${score.total}・${score.verdict === 'candidate' ? '候補' : '要注意'}）の新規上場 ${score.token.baseSymbol} へエントリー`,
            strategy: isMoonbag ? 'ムーンバッグ' : '自動スナイプ',
          })
          session.portfolio = result.portfolio
          session.positionMeta[addr] = {
            entryPriceUsd: score.token.priceUsd,
            triggered: [],
            mint: score.token.baseAddress,
          }
          session.enteredPairs.push(addr)
          session.enteredMints.push(score.token.baseAddress)
          if (!session.watchedPairs.includes(addr)) session.watchedPairs.push(addr)
        } catch (err) {
          // 資金不足等は記録して継続（原則4）
          const { code, message } = formatError(err)
          console.warn(`[${code}] ${message}`)
        }
      }
    },
    /** 1 セッション分の判断・執行（tick から呼ばれる。await 後は id で引き直す） */
    async _processSession(sessionId: string) {
      // 自動スナイプ: 監視 → 監査 → 随時エントリー（出口は下のラダー共通処理）
      const initial = this.sessionById(sessionId)
      if (!initial || !initial.running) return
      if (usesAutoPipeline(initial.method)) {
        await this._autoSnipeEntries(sessionId)
      }
      const session = this.sessionById(sessionId)
      if (!session || !session.running) return

      const strategy = useStrategyStore().docFor('solana')
      const prices = this.priceMap
      // AI 縮退はティック単位で集約する（ペアごとの上書きでは最後の1件の成否しか残らない）
      let aiFailures = 0
      let aiSuccesses = 0

      for (const addr of [...session.watchedPairs]) {
        const current = this.sessionById(sessionId)
        if (!current || !current.running) return
        const token = this.tokenOf(addr)
        if (!token || token.priceUsd <= 0) continue
        const pos = positionOf(current.portfolio, addr)

        if (current.method !== 'ai') {
          // ラダー/スナイプ: エントリー価格基準の出口ルールを機械的に執行
          if (!pos) continue
          const meta = current.positionMeta[addr]
          if (!meta) continue
          const strategyName =
            current.method === 'snipe'
              ? '新規上場スナイプ'
              : current.method === 'auto-snipe'
                ? '自動スナイプ'
                : current.method === 'moonbag'
                  ? 'ムーンバッグ'
                  : 'ラダーロジック'
          const fired = checkLadder(meta.entryPriceUsd, token.priceUsd, current.ladderRules, meta.triggered)
          for (const { index, rule } of fired) {
            const position = positionOf(current.portfolio, addr)
            if (!position || position.quantity <= 0) break
            // 数量指定で発注（notional 逆算の誤差で全量損切りが失敗しない: ISSUE-2）
            const sellQty = position.quantity * rule.sellRatio
            const isMoonbagTp = current.method === 'moonbag' && rule.triggerPct >= 0
            if (sellQty * token.priceUsd < 0.01) {
              meta.triggered.push(index)
              // dust でも TP 発動はムーンバッグ化する（実行上は到達不能だが、TP だけ消費されて
              // 損切りが生き残る不整合を防ぐ防御。エントリー最低 $10 → TP 時の売却額 ≥ $14）
              if (isMoonbagTp) {
                meta.moonbagAt = Date.now()
                meta.triggered = current.ladderRules.map((_, i) => i)
                break
              }
              continue
            }
            try {
              const result = executeOrder(current.portfolio, {
                assetId: addr,
                side: 'sell',
                quantity: sellQty,
                priceUsd: token.priceUsd,
                reason: isMoonbagTp
                  ? `ムーンバッグ利確: +${rule.triggerPct}% 到達で ${Math.round(rule.sellRatio * 100)}% を売却（元本+${Math.round(((1 + rule.triggerPct / 100) * rule.sellRatio - 1) * 100)}% 確定・残りは売却ルールなしで保持）`
                  : rule.triggerPct >= 0
                    ? `ラダー利確: +${rule.triggerPct}% 到達で ${Math.round(rule.sellRatio * 100)}% 決済`
                    : `ラダー損切り: ${rule.triggerPct}% 到達で ${Math.round(rule.sellRatio * 100)}% 決済`,
                strategy: strategyName,
              })
              current.portfolio = result.portfolio
              meta.triggered.push(index)
              if (isMoonbagTp) {
                // ムーンバッグ化: 利確後は損切り含む全ルールを無効化し、残数量を恒久保持する
                meta.moonbagAt = Date.now()
                meta.triggered = current.ladderRules.map((_, i) => i)
                break
              }
            } catch (err) {
              const { code, message } = formatError(err)
              console.warn(`[${code}] ${message}`)
            }
          }
        } else {
          // AI 取引
          const equity = portfolioEquity(current.portfolio, prices)
          const exposureRatio = equity > 0 ? ((pos?.quantity ?? 0) * token.priceUsd) / equity : 0
          const unrealizedPct =
            pos && pos.avgCostUsd > 0
              ? ((token.priceUsd - pos.avgCostUsd) / pos.avgCostUsd) * 100
              : null
          let decision: TradeDecision
          let degraded = false
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
            degraded = true
          }
          // await 中のセッション終了/一時停止を検知したら旧判断を破棄（ISSUE-3）
          const after = this.sessionById(sessionId)
          if (!after || !after.running) return
          if (degraded) aiFailures++
          else aiSuccesses++
          try {
            const result = applyDecision(after.portfolio, decision, {
              assetId: addr,
              priceUsd: token.priceUsd,
              strategy: strategy.name,
              prices,
            })
            if (result) {
              after.portfolio = result.portfolio
              if (result.order.side === 'buy' && !after.positionMeta[addr]) {
                after.positionMeta[addr] = { entryPriceUsd: token.priceUsd, triggered: [] }
              }
              if (result.order.side === 'sell' && !positionOf(after.portfolio, addr)) {
                delete after.positionMeta[addr]
              }
            }
          } catch (err) {
            const { code, message } = formatError(err)
            console.warn(`[${code}] ${message}`)
          }
        }
      }

      const done = this.sessionById(sessionId)
      if (!done) return
      // 1件でも縮退したらバッジ表示、全件成功したティックでのみ解除（途中中断時は維持）
      if (aiFailures > 0) done.aiDegradedAt = Date.now()
      else if (aiSuccesses > 0) done.aiDegradedAt = undefined
      // 自動スナイプ: 全量決済済みペアの監視を剪定（価格取得 30 件枠の温存: ISSUE-P9-M5）
      this._pruneClosedAutoPairs(done)
      done.portfolio = recordEquity(done.portfolio, this.priceMap)
    },
    /** 1ティック: 市場データを一度だけ更新し、実行中の全セッションを順に処理する */
    async tick() {
      if (this.ticking || !this.anyRunning) return
      this.ticking = true
      try {
        await this.fetchTokens()
        for (const id of this.sessions.filter((s) => s.running).map((s) => s.id)) {
          await this._processSession(id)
        }
        this._persist()
      } finally {
        this.ticking = false
      }
    },
  },
})

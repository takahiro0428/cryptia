import { defineStore } from 'pinia'
import { decideTrade, fallbackInsight } from '~/shared/advisor'
import { formatError } from '~/shared/errors'
import { fitArchivesToBudget, fitSessionsToBudget, utf8Bytes } from '~/shared/persistBudget'
import {
  applyDecision,
  createPortfolio,
  portfolioEquity,
  positionOf,
  recordEquity,
  summarize,
} from '~/shared/tradeEngine'
import type { Order, Portfolio, PortfolioSummary, TradeDecision } from '~/shared/types'
import { aiAuthHeaders } from '~/composables/useFirebase'
import { persist, restore } from '~/composables/usePersistence'
import { useMarketStore } from '~/stores/market'
import { useStrategyStore } from '~/stores/strategy'
import { useUiStore } from '~/stores/ui'

const STORE_KEY = 'demo-trade'
/** 判断ティック間隔（価格ポーリング 15s に対し 20s で1テンポ遅らせる） */
export const TICK_INTERVAL_MS = 20_000
/** 同時に持てるセッション数の上限（UI・保存の複雑性の抑制） */
export const MAX_DEMO_SESSIONS = 5
/**
 * AI エンジンのセッション×銘柄の合計上限。20s ティック = 3 回/分のため
 * 8 銘柄で最大 24 回/分。AI API のレートリミット（uid 単位 40/分）は
 * Solana魔界の AI 手法（最大 12 回/分）・市場インサイト・実トレードの
 * 手動 AI 判断と**共有**のため、自動枠の合算 36 回/分 + 手動系の余裕
 * 4 回/分 で 40/分内に収める（ISSUE-P9-M13）
 */
export const MAX_AI_ASSETS_TOTAL = 8
/** アーカイブ1件に保存する約定履歴の上限（Firestore ドキュメント容量保護） */
const ARCHIVE_ORDERS_MAX = 100
/** 約定履歴を保持するアーカイブ数（それより古いものはサマリーのみ残す） */
const ARCHIVE_ORDERS_KEEP = 10

export type EngineMode = 'ai' | 'logic'

/** 自動売買セッション（複数同時実行可能: F-04） */
export interface DemoSession {
  id: string
  name: string
  createdAt: number
  portfolio: Portfolio
  running: boolean
  assetIds: string[]
  engineMode: EngineMode
  /** AI 判断がレートリミット等でロジックへ縮退した最終時刻（UI で明示する） */
  aiDegradedAt?: number
}

interface ArchivedSession {
  endedAt: number
  summary: PortfolioSummary
  strategyName: string
  assetIds: string[]
  /** 約定履歴（閲覧用: F-04）。容量保護のため直近セッション分のみ保持 */
  orders?: Order[]
  /** セッション名（複数セッション対応後の追加フィールド） */
  name?: string
}

/** 旧形式（単一セッション）を含む永続化ペイロード */
interface PersistedDemo {
  sessions?: DemoSession[]
  /** セッション既定名の通し番号（途中終了で番号が重複しないよう永続化） */
  sessionCounter?: number
  archives: ArchivedSession[]
  /** 旧形式（v1: 単一セッション）。移行用に残す（原則7） */
  portfolio?: Portfolio | null
  running?: boolean
  assetIds?: string[]
  engineMode?: EngineMode
}

let sessionSeq = 0
function newSessionId(): string {
  return `demo-${Date.now().toString(36)}-${++sessionSeq}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * AI デモトレードストア（UC-4 / F-04）。
 * - **複数セッションを同時実行**できる（それぞれ独立した資金・銘柄・エンジン・実行状態）
 * - ティックはストアで一本化し、実行中の全セッションを順に処理する（API 負荷の平準化）
 * - 注文履歴は追記型（BR-7）。過去セッションはアーカイブとして保護する（原則2）
 */
export const useDemoTradeStore = defineStore('demoTrade', {
  state: () => ({
    sessions: [] as DemoSession[],
    /** セッション既定名の通し番号（重複防止のため永続化） */
    sessionCounter: 0,
    archives: [] as ArchivedSession[],
    ticking: false,
    restored: false,
    _timer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    sessionById: (state) => (id: string) => state.sessions.find((s) => s.id === id),
    anyRunning: (state) => state.sessions.some((s) => s.running),
    summaryOf() {
      return (id: string): PortfolioSummary | null => {
        const session = this.sessionById(id)
        if (!session) return null
        return summarize(session.portfolio, useMarketStore().priceMap)
      }
    },
    equityOf() {
      return (id: string): number => {
        const session = this.sessionById(id)
        if (!session) return 0
        return portfolioEquity(session.portfolio, useMarketStore().priceMap)
      }
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const saved = await restore<PersistedDemo>(STORE_KEY)
      if (saved) {
        this.archives = saved.archives ?? []
        this.sessionCounter = saved.sessionCounter ?? 0
        if (saved.sessions) {
          this.sessions = saved.sessions
        } else if (saved.portfolio) {
          // 旧形式（単一セッション）からの移行（原則7: 下位互換）
          this.sessions = [
            {
              id: newSessionId(),
              name: 'セッション 1',
              createdAt: Date.now(),
              portfolio: saved.portfolio,
              running: saved.running ?? false,
              assetIds: saved.assetIds ?? [],
              engineMode: saved.engineMode ?? 'logic',
            },
          ]
          // 移行セッションが「セッション 1」を使うため、次の既定名は「セッション 2」から
          this.sessionCounter = Math.max(this.sessionCounter, 1)
        }
        // 再訪時、実行中セッションは自動再開する（手動ステップを残さない: 原則1）
        if (this.anyRunning) this.startTicking()
      }
      this.restored = true
    },
    _persist() {
      const payload: PersistedDemo = {
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
      persist<PersistedDemo>(STORE_KEY, payload)
    },
    /** AI おすすめ銘柄（短期スタンスのスコア上位。UC-4: 銘柄は AI おすすめから選べる） */
    recommendedAssets(limit = 4): { assetId: string; confidence: number; summary: string }[] {
      const market = useMarketStore()
      return market.tickers
        .map((t) => {
          const ins = fallbackInsight(t, 'short')
          const score =
            ins.stance === 'bullish' ? ins.confidence : ins.stance === 'neutral' ? 0 : -ins.confidence
          return { assetId: t.assetId, confidence: ins.confidence, summary: ins.summary, score }
        })
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ assetId, confidence, summary }) => ({ assetId, confidence, summary }))
    },
    /** 新しいセッションを開始する（既存セッションは動かしたまま追加できる） */
    start(initialUsd: number, assetIds: string[], engineMode: EngineMode, name = '') {
      const ui = useUiStore()
      if (this.sessions.length >= MAX_DEMO_SESSIONS) {
        ui.notify(`同時に実行できるセッションは ${MAX_DEMO_SESSIONS} 件までです。不要なセッションを終了してください`, 'warn')
        return
      }
      if (assetIds.length === 0) {
        ui.notify('取引対象の銘柄を1つ以上選択してください', 'warn')
        return
      }
      // AI 判断 API のレートリミット（認証済み 40/分）内に収める合計上限（サイレント縮退の防止）
      if (engineMode === 'ai') {
        const aiAssetsTotal =
          this.sessions
            .filter((s) => s.engineMode === 'ai')
            .reduce((sum, s) => sum + s.assetIds.length, 0) + assetIds.length
        if (aiAssetsTotal > MAX_AI_ASSETS_TOTAL) {
          ui.notify(
            `AI エンジンの合計銘柄数は ${MAX_AI_ASSETS_TOTAL} までです（AI 判断 API の混雑防止）。銘柄数を減らすか、ロジックエンジンをご利用ください`,
            'warn',
          )
          return
        }
      }
      try {
        const session: DemoSession = {
          id: newSessionId(),
          name: name.trim().slice(0, 30) || `セッション ${++this.sessionCounter}`,
          createdAt: Date.now(),
          portfolio: createPortfolio(initialUsd),
          running: true,
          assetIds: [...assetIds],
          engineMode,
        }
        this.sessions.push(session)
        this.startTicking()
        this._persist()
        ui.notify(`「${session.name}」を開始しました（初期資金 $${initialUsd.toLocaleString()}）`)
      } catch (err) {
        const { code, message } = formatError(err)
        ui.notify(message, 'error', code)
      }
    },
    startTicking() {
      if (this._timer) return
      // 再開状態を即時永続化する（リロードで停止状態に巻き戻さない: 原則2）
      this._persist()
      this._timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
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
        const strategyName = useStrategyStore().docFor('demo').name
        this.archives.unshift({
          endedAt: Date.now(),
          summary: summarize(session.portfolio, useMarketStore().priceMap),
          strategyName,
          assetIds: [...session.assetIds],
          orders: session.portfolio.orders.slice(-ARCHIVE_ORDERS_MAX),
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
      useUiStore().notify(`「${session.name}」を終了し、結果を過去セッション（約定履歴つき）に保存しました`)
    },
    /** 1ティック分の自動売買。実行中の全セッション × 銘柄ごとに判断 → 執行 → 資産推移記録 */
    async tick() {
      if (this.ticking) return
      this.ticking = true
      try {
        const market = useMarketStore()
        const strategyStore = useStrategyStore()
        const strategy = strategyStore.docFor('demo')

        for (const id of this.sessions.filter((s) => s.running).map((s) => s.id)) {
          // await を挟むためセッションは毎回 id で引き直す（終了済みなら処理しない）
          const session = this.sessionById(id)
          if (!session || !session.running) continue
          const prices = market.priceMap
          // AI 縮退はティック単位で集約する（銘柄ごとの上書きでは最後の1件の成否しか残らない）
          let aiFailures = 0
          let aiSuccesses = 0
          let interrupted = false

          for (const assetId of [...session.assetIds]) {
            const current = this.sessionById(id)
            if (!current || !current.running) {
              interrupted = true
              break
            }
            const ticker = market.tickerOf(assetId)
            if (!ticker || ticker.priceUsd <= 0) continue

            const equity = portfolioEquity(current.portfolio, prices)
            const pos = positionOf(current.portfolio, assetId)
            const exposureRatio = equity > 0 ? ((pos?.quantity ?? 0) * ticker.priceUsd) / equity : 0
            const unrealizedPct =
              pos && pos.avgCostUsd > 0
                ? ((ticker.priceUsd - pos.avgCostUsd) / pos.avgCostUsd) * 100
                : null

            let decision: TradeDecision
            if (current.engineMode === 'ai') {
              let degraded = false
              try {
                decision = await $fetch<TradeDecision>('/api/ai/decision', {
                  method: 'POST',
                  body: {
                    ticker,
                    strategy,
                    exposureRatio,
                    unrealizedPct,
                    library: strategyStore.allDocs.slice(0, 10),
                  },
                  headers: await aiAuthHeaders(),
                  timeout: 12_000,
                })
              } catch {
                // サーバー未達・レートリミット時はローカルロジックにフォールバック（BR-5）
                decision = decideTrade(ticker, { strategy, exposureRatio, unrealizedPct })
                degraded = true
              }
              // await 中にセッションが終了されていたら旧判断を破棄（ISSUE-3）
              const after = this.sessionById(id)
              if (!after || !after.running) {
                interrupted = true
                break
              }
              if (degraded) aiFailures++
              else aiSuccesses++
            } else {
              decision = decideTrade(ticker, { strategy, exposureRatio, unrealizedPct })
            }

            try {
              const target = this.sessionById(id)
              if (!target) break
              const result = applyDecision(target.portfolio, decision, {
                assetId,
                priceUsd: ticker.priceUsd,
                strategy: strategy.name,
                prices,
              })
              if (result) target.portfolio = result.portfolio
            } catch (err) {
              // 資金不足等はコード付きで記録して継続（原則4）
              const { code, message } = formatError(err)
              console.warn(`[${code}] ${message}`)
            }
          }

          const done = this.sessionById(id)
          if (done) {
            // 1件でも縮退したらバッジ表示、全件成功したティックでのみ解除。
            // 一時停止等で中断した不完全ティックでは変更しない（solana 側と同じ意味論）
            if (!interrupted) {
              if (aiFailures > 0) done.aiDegradedAt = Date.now()
              else if (aiSuccesses > 0) done.aiDegradedAt = undefined
            }
            done.portfolio = recordEquity(done.portfolio, market.priceMap)
          }
        }
        this._persist()
      } finally {
        this.ticking = false
      }
    },
  },
})

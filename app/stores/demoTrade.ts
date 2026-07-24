import { defineStore } from 'pinia'
import { decideTrade, fallbackInsight } from '~/shared/advisor'
import { formatError } from '~/shared/errors'
import {
  applyDecision,
  createPortfolio,
  portfolioEquity,
  positionOf,
  recordEquity,
  summarize,
} from '~/shared/tradeEngine'
import type { Portfolio, PortfolioSummary, TradeDecision } from '~/shared/types'
import { aiAuthHeaders } from '~/composables/useFirebase'
import { persist, restore } from '~/composables/usePersistence'
import { useMarketStore } from '~/stores/market'
import { useStrategyStore } from '~/stores/strategy'
import { useUiStore } from '~/stores/ui'

const STORE_KEY = 'demo-trade'
/** 判断ティック間隔（価格ポーリング 15s に対し 20s で1テンポ遅らせる） */
export const TICK_INTERVAL_MS = 20_000

export type EngineMode = 'ai' | 'logic'

interface ArchivedSession {
  endedAt: number
  summary: PortfolioSummary
  strategyName: string
  assetIds: string[]
}

interface PersistedDemo {
  portfolio: Portfolio | null
  running: boolean
  assetIds: string[]
  engineMode: EngineMode
  archives: ArchivedSession[]
}

/**
 * AI デモトレードストア（UC-4 / F-04）。
 * - 初期資金を設定し、選択銘柄を AI/ロジックが自動売買する
 * - 注文履歴は追記型（BR-7）。過去セッションはアーカイブとして保護する（原則2）
 */
export const useDemoTradeStore = defineStore('demoTrade', {
  state: () => ({
    portfolio: null as Portfolio | null,
    running: false,
    assetIds: [] as string[],
    engineMode: 'logic' as EngineMode,
    archives: [] as ArchivedSession[],
    ticking: false,
    restored: false,
    _timer: null as ReturnType<typeof setInterval> | null,
    /** セッション世代。await 中に終了/再開始された旧ティックの執行を防ぐ（ISSUE-3） */
    _session: 0,
  }),
  getters: {
    summary(state): PortfolioSummary | null {
      if (!state.portfolio) return null
      return summarize(state.portfolio, useMarketStore().priceMap)
    },
    equityUsd(state): number {
      if (!state.portfolio) return 0
      return portfolioEquity(state.portfolio, useMarketStore().priceMap)
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const saved = await restore<PersistedDemo>(STORE_KEY)
      if (saved) {
        this.portfolio = saved.portfolio
        this.assetIds = saved.assetIds ?? []
        this.engineMode = saved.engineMode ?? 'logic'
        this.archives = saved.archives ?? []
        // 再訪時、実行中セッションは自動再開する（手動ステップを残さない: 原則1）
        if (saved.running && this.portfolio) this.startTicking()
      }
      this.restored = true
    },
    _persist() {
      persist<PersistedDemo>(STORE_KEY, {
        portfolio: this.portfolio ? JSON.parse(JSON.stringify(this.portfolio)) : null,
        running: this.running,
        assetIds: [...this.assetIds],
        engineMode: this.engineMode,
        archives: JSON.parse(JSON.stringify(this.archives)),
      })
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
    start(initialUsd: number, assetIds: string[], engineMode: EngineMode) {
      const ui = useUiStore()
      if (this.running) {
        ui.notify('デモトレードは既に実行中です', 'warn')
        return
      }
      if (assetIds.length === 0) {
        ui.notify('取引対象の銘柄を1つ以上選択してください', 'warn')
        return
      }
      try {
        // 既存セッションがあればアーカイブしてから新規開始（進捗の巻き戻し防止: 原則2）
        this.archiveCurrent()
        this._session++
        this.portfolio = createPortfolio(initialUsd)
        this.assetIds = [...assetIds]
        this.engineMode = engineMode
        this.startTicking()
        this._persist()
        ui.notify(`デモトレードを開始しました（初期資金 $${initialUsd.toLocaleString()}）`)
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
      this._timer = setInterval(() => void this.tick(), TICK_INTERVAL_MS)
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
    /** 現在のセッションをアーカイブへ退避（履歴は消さない） */
    archiveCurrent() {
      if (!this.portfolio || this.portfolio.orders.length === 0) {
        this.portfolio = null
        return
      }
      const strategyName = useStrategyStore().activeDoc.name
      this.archives.unshift({
        endedAt: Date.now(),
        summary: summarize(this.portfolio, useMarketStore().priceMap),
        strategyName,
        assetIds: [...this.assetIds],
      })
      this.archives = this.archives.slice(0, 20)
      this._session++
      this.portfolio = null
    },
    /** セッション終了（停止 + アーカイブ） */
    endSession() {
      this.stop()
      this.archiveCurrent()
      this._persist()
      useUiStore().notify('セッションを終了し、結果をアーカイブに保存しました')
    },
    /** 1ティック分の自動売買。銘柄ごとに判断 → 執行 → 資産推移記録 */
    async tick() {
      if (this.ticking || !this.running || !this.portfolio) return
      this.ticking = true
      const session = this._session
      try {
        const market = useMarketStore()
        const strategyStore = useStrategyStore()
        const strategy = strategyStore.activeDoc
        const prices = market.priceMap

        for (const assetId of [...this.assetIds]) {
          if (!this.portfolio) break
          const ticker = market.tickerOf(assetId)
          if (!ticker || ticker.priceUsd <= 0) continue

          const equity = portfolioEquity(this.portfolio, prices)
          const pos = positionOf(this.portfolio, assetId)
          const exposureRatio = equity > 0 ? ((pos?.quantity ?? 0) * ticker.priceUsd) / equity : 0
          const unrealizedPct =
            pos && pos.avgCostUsd > 0
              ? ((ticker.priceUsd - pos.avgCostUsd) / pos.avgCostUsd) * 100
              : null

          let decision: TradeDecision
          if (this.engineMode === 'ai') {
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
              // サーバー未達時はローカルロジックにフォールバック（BR-5）
              decision = decideTrade(ticker, { strategy, exposureRatio, unrealizedPct })
            }
            // await 中にセッションが終了/再開始されていたら旧判断を破棄（ISSUE-3）
            if (this._session !== session || !this.running || !this.portfolio) return
          } else {
            decision = decideTrade(ticker, { strategy, exposureRatio, unrealizedPct })
          }

          try {
            const result = applyDecision(this.portfolio, decision, {
              assetId,
              priceUsd: ticker.priceUsd,
              strategy: strategy.name,
              prices,
            })
            if (result) this.portfolio = result.portfolio
          } catch (err) {
            // 資金不足等はコード付きで記録して継続（原則4）
            const { code, message } = formatError(err)
            console.warn(`[${code}] ${message}`)
          }
        }

        if (this.portfolio) {
          this.portfolio = recordEquity(this.portfolio, market.priceMap)
        }
        this._persist()
      } finally {
        this.ticking = false
      }
    },
  },
})

import { defineStore } from 'pinia'
import { ASSETS } from '~/shared/assets'
import { CryptiaError, ERROR_CODES } from '~/shared/errors'
import { mockTickers } from '~/shared/mockData'
import type { FlowPeriod, FundFlow, Ticker } from '~/shared/types'
import { estimateFlows } from '~/shared/flow'

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets'
/** NFR: 価格更新間隔 15 秒（CoinGecko 無償枠のレートリミット内） */
export const POLL_INTERVAL_MS = 15_000

interface CoinGeckoMarket {
  id: string
  current_price: number
  price_change_percentage_1h_in_currency?: number
  price_change_percentage_24h_in_currency?: number
  price_change_percentage_7d_in_currency?: number
  market_cap: number
  total_volume: number
  sparkline_in_7d?: { price: number[] }
}

/** 市場データストア（SoT はサーバー側=CoinGecko。本ストアはキャッシュ: 原則6） */
export const useMarketStore = defineStore('market', {
  state: () => ({
    tickers: [] as Ticker[],
    loading: false,
    /** 実データ取得に失敗しモック表示中か（UI で警告表示: BR-5） */
    usingMockData: false,
    lastUpdatedAt: 0,
    lastError: '' as string,
    _pollTimer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    tickerOf: (state) => (assetId: string) => state.tickers.find((t) => t.assetId === assetId),
    priceMap: (state): Record<string, number> =>
      Object.fromEntries(state.tickers.map((t) => [t.assetId, t.priceUsd])),
    flowsFor:
      (state) =>
      (period: FlowPeriod): FundFlow[] =>
        estimateFlows(state.tickers, period),
  },
  actions: {
    async fetchTickers() {
      this.loading = this.tickers.length === 0
      try {
        const ids = ASSETS.map((a) => a.id).join(',')
        const url = `${COINGECKO_URL}?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=1h,24h,7d&per_page=${ASSETS.length}`
        const res = await fetch(url)
        if (!res.ok) {
          throw new CryptiaError(
            ERROR_CODES.MARKET_FETCH_FAILED,
            `価格 API がエラーを返しました（HTTP ${res.status}）`,
          )
        }
        const data = (await res.json()) as CoinGeckoMarket[]
        if (!Array.isArray(data) || data.length === 0) {
          throw new CryptiaError(ERROR_CODES.MARKET_FETCH_FAILED, '価格 API の応答が空でした')
        }
        const now = Date.now()
        this.tickers = data.map((m) => ({
          assetId: m.id,
          priceUsd: m.current_price ?? 0,
          change1hPct: m.price_change_percentage_1h_in_currency ?? 0,
          change24hPct: m.price_change_percentage_24h_in_currency ?? 0,
          change7dPct: m.price_change_percentage_7d_in_currency ?? 0,
          marketCapUsd: m.market_cap ?? 0,
          volume24hUsd: m.total_volume ?? 0,
          sparkline7d: m.sparkline_in_7d?.price ?? [],
          updatedAt: now,
        }))
        this.usingMockData = false
        this.lastUpdatedAt = now
        this.lastError = ''
      } catch (err) {
        // 取得失敗時: 既存データがあれば保持（最終キャッシュ表示）、なければモックで劣化継続
        this.lastError = err instanceof Error ? err.message : String(err)
        console.warn(`[${ERROR_CODES.MARKET_FETCH_FAILED}] ${this.lastError}`)
        if (this.tickers.length === 0) {
          this.tickers = mockTickers()
          this.usingMockData = true
          this.lastUpdatedAt = Date.now()
        }
      } finally {
        this.loading = false
      }
    },
    /** ポーリング開始（多重起動しない: 冪等） */
    startPolling() {
      if (this._pollTimer) return
      void this.fetchTickers()
      this._pollTimer = setInterval(() => void this.fetchTickers(), POLL_INTERVAL_MS)
    },
    stopPolling() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
    },
  },
})

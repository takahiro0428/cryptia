import { defineStore } from 'pinia'
import { ASSETS } from '~/shared/assets'
import { BINANCE_SYMBOLS, KLINE_PARAMS, netTakerFlowUsd, parseMiniTicker } from '~/shared/binance'
import { CryptiaError, ERROR_CODES } from '~/shared/errors'
import { mockTickers } from '~/shared/mockData'
import type { FlowPeriod, FundFlow, Ticker } from '~/shared/types'
import { buildFlowMatrix, estimateFlows, heuristicNetUsd, type FlowEntry } from '~/shared/flow'

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets'
const BINANCE_API = 'https://api.binance.com/api/v3'
const BINANCE_WS = 'wss://stream.binance.com:9443/stream'
/** メタデータ（時価総額・スパークライン等）の更新間隔。価格ティックは WebSocket で即時 */
export const POLL_INTERVAL_MS = 15_000
/** 実測ネットフローのキャッシュ有効期間 */
const NET_FLOW_TTL_MS = 5 * 60 * 1000

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
    /** WebSocket ストリーミング接続状態（価格の即時更新） */
    streaming: false,
    /** 期間別の実測ネットフロー（Binance テイカーフロー） */
    netFlows: {} as Partial<Record<FlowPeriod, { entries: FlowEntry[]; fetchedAt: number }>>,
    /** 取得中の期間（期間別に管理。単一フラグだと切替時に取得が黙って落ちる: ISSUE-P8-3） */
    netFlowLoading: [] as FlowPeriod[],
    _pollTimer: null as ReturnType<typeof setInterval> | null,
    _ws: null as WebSocket | null,
    _wsRetryTimer: null as ReturnType<typeof setTimeout> | null,
    /** 価格の取得経路。直接取得に失敗したらプロキシへ sticky 切替（自己回復つき） */
    _via: 'direct' as 'direct' | 'proxy',
    /** 多重フェッチ防止（最悪ケースで応答がポーリング間隔を超えるため: ISSUE-P9-M2） */
    _fetching: false,
  }),
  getters: {
    tickerOf: (state) => (assetId: string) => state.tickers.find((t) => t.assetId === assetId),
    priceMap: (state): Record<string, number> =>
      Object.fromEntries(state.tickers.map((t) => [t.assetId, t.priceUsd])),
    /**
     * 銘柄間フロー。実測ネットフロー（Binance）があれば実測ベース、
     * なければ従来の推定モデルへフォールバック（BR-5）。
     */
    flowsFor:
      (state) =>
      (period: FlowPeriod): FundFlow[] => {
        const measured = state.netFlows[period]
        if (measured && measured.entries.some((e) => e.measured)) {
          return buildFlowMatrix(measured.entries)
        }
        return estimateFlows(state.tickers, period)
      },
    /** フローのデータソース表示用（measured-hybrid: 実測+未上場銘柄の推定補完） */
    flowSource:
      (state) =>
      (period: FlowPeriod): 'measured-hybrid' | 'estimated' =>
        state.netFlows[period]?.entries.some((e) => e.measured) ? 'measured-hybrid' : 'estimated',
  },
  actions: {
    /**
     * CoinGecko 取得（直接 → 失敗時は自アプリのプロキシへ sticky 切替）。
     * ブラウザから到達できない環境（ネットワーク遮断・広告ブロッカー等）で
     * 毎ポーリングの直接タイムアウト待ちを繰り返さない。プロキシも失敗したら
     * 次回は直接から再試行する（自己回復）。
     */
    async _fetchMarkets(url: string): Promise<CoinGeckoMarket[]> {
      if (this._via === 'direct') {
        try {
          const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
          if (!res.ok) {
            throw new CryptiaError(
              ERROR_CODES.MARKET_FETCH_FAILED,
              `価格 API がエラーを返しました（HTTP ${res.status}）`,
            )
          }
          return (await res.json()) as CoinGeckoMarket[]
        } catch {
          const data = await $fetch<CoinGeckoMarket[]>('/api/market/tickers', { timeout: 12_000 })
          this._via = 'proxy'
          return data
        }
      }
      try {
        return await $fetch<CoinGeckoMarket[]>('/api/market/tickers', { timeout: 12_000 })
      } catch (err) {
        this._via = 'direct'
        throw err
      }
    },
    async fetchTickers() {
      if (this._fetching) return
      this._fetching = true
      this.loading = this.tickers.length === 0
      try {
        const ids = ASSETS.map((a) => a.id).join(',')
        const url = `${COINGECKO_URL}?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=1h,24h,7d&per_page=${ASSETS.length}`
        const data = await this._fetchMarkets(url)
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
        this._fetching = false
      }
    },
    /** ポーリング開始（多重起動しない: 冪等）。同時に価格ストリーミングも開始する */
    startPolling() {
      if (this._pollTimer) return
      void this.fetchTickers()
      this._pollTimer = setInterval(() => void this.fetchTickers(), POLL_INTERVAL_MS)
      this.startStreaming()
    },
    stopPolling() {
      if (this._pollTimer) {
        clearInterval(this._pollTimer)
        this._pollTimer = null
      }
      this.stopStreaming()
    },
    /**
     * Binance miniTicker WebSocket による価格の即時更新（F-01 本格化）。
     * CoinGecko ポーリングはメタデータ（時価総額・スパークライン）と
     * Binance 未上場銘柄（株式トークン等）の価格を引き続き担う。
     * 切断時は 5 秒後に自動再接続。失敗してもポーリングが継続するため劣化のみ（BR-5）。
     */
    startStreaming() {
      if (this._ws || typeof WebSocket === 'undefined') return
      const streams = Object.values(BINANCE_SYMBOLS)
        .filter((s): s is string => s !== null)
        .map((s) => `${s.toLowerCase()}@miniTicker`)
        .join('/')
      try {
        const ws = new WebSocket(`${BINANCE_WS}?streams=${streams}`)
        this._ws = ws
        ws.onopen = () => {
          this.streaming = true
        }
        ws.onmessage = (ev) => {
          try {
            const payload = JSON.parse(String(ev.data)) as { data?: unknown }
            const tick = parseMiniTicker(payload.data)
            if (!tick) return
            const ticker = this.tickers.find((t) => t.assetId === tick.assetId)
            if (ticker && !this.usingMockData) {
              ticker.priceUsd = tick.priceUsd
              ticker.change24hPct = tick.change24hPct
              ticker.updatedAt = Date.now()
              this.lastUpdatedAt = Date.now()
            }
          } catch {
            /* 不正メッセージは無視 */
          }
        }
        ws.onclose = () => {
          // stop→start 直後に旧ソケットの close が後着した場合、新ソケットの参照を
          // 破棄しない（孤児ソケット・二重接続の防止: ISSUE-P8-6）
          if (this._ws !== ws) return
          this.streaming = false
          this._ws = null
          // 自動再接続（stopStreaming 済みならタイマーは張らない）
          if (this._pollTimer && !this._wsRetryTimer) {
            this._wsRetryTimer = setTimeout(() => {
              this._wsRetryTimer = null
              this.startStreaming()
            }, 5_000)
          }
        }
        ws.onerror = () => ws.close()
      } catch {
        this.streaming = false
        this._ws = null
      }
    },
    stopStreaming() {
      if (this._wsRetryTimer) {
        clearTimeout(this._wsRetryTimer)
        this._wsRetryTimer = null
      }
      this._ws?.close()
      this._ws = null
      this.streaming = false
    },
    /**
     * 実測ネットフローの取得（F-02 本格化）。
     * Binance kline のテイカー買い/売り出来高から銘柄別の実測資金流入出を算出し、
     * 未上場銘柄は推定値で補完する。失敗時は従来の推定モデルにフォールバック。
     */
    async fetchNetFlows(period: FlowPeriod) {
      const cached = this.netFlows[period]
      if (cached && Date.now() - cached.fetchedAt < NET_FLOW_TTL_MS) return
      if (this.netFlowLoading.includes(period)) return
      this.netFlowLoading.push(period)
      try {
        const { interval, limit } = KLINE_PARAMS[period]
        const mapped = ASSETS.map((a) => ({ assetId: a.id, symbol: BINANCE_SYMBOLS[a.id] }))
        const results = await Promise.allSettled(
          mapped.map(async ({ assetId, symbol }): Promise<FlowEntry | null> => {
            if (!symbol) return null
            const res = await fetch(
              `${BINANCE_API}/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`,
            )
            if (!res.ok) throw new Error(`Binance HTTP ${res.status}`)
            const klines = (await res.json()) as unknown[][]
            return { assetId, netUsd: netTakerFlowUsd(klines), measured: true }
          }),
        )
        const entries: FlowEntry[] = []
        let measuredCount = 0
        results.forEach((r, i) => {
          if (r.status === 'fulfilled' && r.value) {
            entries.push(r.value)
            measuredCount++
          } else {
            // Binance 未上場・取得失敗の銘柄は推定値で補完する
            const ticker = this.tickers.find((t) => t.assetId === mapped[i].assetId)
            if (ticker) {
              entries.push({
                assetId: ticker.assetId,
                netUsd: heuristicNetUsd(ticker, period),
                measured: false,
              })
            }
          }
        })
        // 実測が過半に満たない場合は全体を推定モデルに任せる（信頼性の混在を避ける）
        if (measuredCount >= 5) {
          this.netFlows[period] = { entries, fetchedAt: Date.now() }
        }
      } catch (err) {
        console.warn(
          `[${ERROR_CODES.MARKET_FETCH_FAILED}] ネットフロー取得失敗（推定モデルで継続）: ${err instanceof Error ? err.message : err}`,
        )
      } finally {
        this.netFlowLoading = this.netFlowLoading.filter((p) => p !== period)
      }
    },
  },
})

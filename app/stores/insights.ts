import { defineStore } from 'pinia'
import { fallbackInsight } from '~/shared/advisor'
import type { Horizon, Insight, NewsItem, Ticker } from '~/shared/types'
import { useStrategyStore } from '~/stores/strategy'

/** インサイトのキャッシュ有効期間（同一銘柄×時間軸の再生成を抑制） */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * AI インサイトストア（UC-3 / F-03）。
 * サーバー API（Vertex AI）を呼び、失敗時はクライアント内フォールバックで生成する。
 */
export const useInsightsStore = defineStore('insights', {
  state: () => ({
    cache: {} as Record<string, Insight>,
    loadingKeys: [] as string[],
    news: [] as NewsItem[],
    newsLoaded: false,
  }),
  getters: {
    insightFor: (state) => (assetId: string, horizon: Horizon) =>
      state.cache[`${assetId}:${horizon}`],
    isLoading: (state) => (assetId: string, horizon: Horizon) =>
      state.loadingKeys.includes(`${assetId}:${horizon}`),
  },
  actions: {
    async fetchInsight(ticker: Ticker, horizon: Horizon, force = false): Promise<Insight> {
      const key = `${ticker.assetId}:${horizon}`
      const cached = this.cache[key]
      if (!force && cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) return cached
      if (this.loadingKeys.includes(key)) return cached ?? fallbackInsight(ticker, horizon)

      this.loadingKeys.push(key)
      const strategy = useStrategyStore().activeDoc
      try {
        const insight = await $fetch<Insight>('/api/ai/insight', {
          method: 'POST',
          body: { ticker, horizon, strategy },
          timeout: 15_000,
        })
        this.cache[key] = insight
        return insight
      } catch {
        // サーバー未達（オフライン等）はクライアント内フォールバック（BR-5）
        const insight = fallbackInsight(ticker, horizon, strategy)
        this.cache[key] = insight
        return insight
      } finally {
        this.loadingKeys = this.loadingKeys.filter((k) => k !== key)
      }
    },
    async fetchNews() {
      try {
        const res = await $fetch<{ items: NewsItem[] }>('/api/news', { timeout: 10_000 })
        this.news = res.items
      } catch {
        this.news = []
      } finally {
        this.newsLoaded = true
      }
    },
  },
})

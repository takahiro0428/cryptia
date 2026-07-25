import { defineStore } from 'pinia'
import { fallbackInsight } from '~/shared/advisor'
import type { Horizon, Insight, NewsItem, Ticker } from '~/shared/types'
import { aiAuthHeaders } from '~/composables/useFirebase'
import { useStrategyStore } from '~/stores/strategy'

/** インサイトのキャッシュ有効期間（同一銘柄×時間軸の再生成を抑制） */
const CACHE_TTL_MS = 5 * 60 * 1000

/**
 * AI インサイトストア（UC-3 / F-03）。
 * サーバー API（Vertex AI）を呼び、失敗時はクライアント内フォールバックで生成する。
 */
/**
 * キャッシュキーには適用中戦略（insights コンテキスト）の ID を含める。
 * 画面別戦略ピッカーで切り替えた瞬間に表示が追随し、戦略とインサイトの
 * サイレント不一致（最大 5 分）を防ぐ（ISSUE-P9-M3）。
 */
function insightKey(assetId: string, horizon: Horizon): string {
  return `${assetId}:${horizon}:${useStrategyStore().docFor('insights').id}`
}

export const useInsightsStore = defineStore('insights', {
  state: () => ({
    cache: {} as Record<string, Insight>,
    loadingKeys: [] as string[],
    news: [] as NewsItem[],
    newsLoaded: false,
  }),
  getters: {
    insightFor: (state) => (assetId: string, horizon: Horizon) =>
      state.cache[insightKey(assetId, horizon)],
    isLoading: (state) => (assetId: string, horizon: Horizon) =>
      state.loadingKeys.includes(insightKey(assetId, horizon)),
  },
  actions: {
    async fetchInsight(ticker: Ticker, horizon: Horizon, force = false): Promise<Insight> {
      const key = insightKey(ticker.assetId, horizon)
      const cached = this.cache[key]
      if (!force && cached && Date.now() - cached.generatedAt < CACHE_TTL_MS) return cached
      if (this.loadingKeys.includes(key)) return cached ?? fallbackInsight(ticker, horizon)

      this.loadingKeys.push(key)
      const strategyStore = useStrategyStore()
      const strategy = strategyStore.docFor('insights')
      try {
        const insight = await $fetch<Insight>('/api/ai/insight', {
          method: 'POST',
          // library = RAG 検索対象の戦略ライブラリ / headers = 認証済み優遇レートリミット
          body: { ticker, horizon, strategy, library: strategyStore.allDocs.slice(0, 10) },
          headers: await aiAuthHeaders(),
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

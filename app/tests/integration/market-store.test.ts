import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ASSETS } from '~/shared/assets'
import { useMarketStore } from '~/stores/market'

/**
 * 結合テスト: 市場データストア × フェッチ層。
 * API 障害時のグレースフルデグラデーション（BR-5）を検証する。
 */
describe('市場データストア結合', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('API 失敗時はモックデータへフォールバックし usingMockData を立てる', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const store = useMarketStore()
    await store.fetchTickers()
    expect(store.usingMockData).toBe(true)
    expect(store.tickers).toHaveLength(ASSETS.length)
    expect(store.loading).toBe(false)
    vi.unstubAllGlobals()
  })

  it('API 成功時は実データを採用し、フロー推定・価格マップが機能する', async () => {
    const payload = ASSETS.map((a, i) => ({
      id: a.id,
      current_price: 100 + i,
      price_change_percentage_1h_in_currency: i % 2 === 0 ? 1 : -1,
      price_change_percentage_24h_in_currency: i % 2 === 0 ? 5 : -5,
      price_change_percentage_7d_in_currency: 2,
      market_cap: 1e9,
      total_volume: 1e8,
      sparkline_in_7d: { price: [1, 2, 3] },
    }))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: true, json: async () => payload }),
    )
    const store = useMarketStore()
    await store.fetchTickers()
    expect(store.usingMockData).toBe(false)
    expect(store.tickerOf('bitcoin')?.priceUsd).toBe(100)
    expect(Object.keys(store.priceMap)).toHaveLength(ASSETS.length)
    const flows = store.flowsFor('24h')
    expect(flows.length).toBeGreaterThan(0)
    vi.unstubAllGlobals()
  })

  it('一度実データ取得後に API が落ちても既存データを保持する（最終キャッシュ表示）', async () => {
    const payload = ASSETS.map((a) => ({
      id: a.id,
      current_price: 500,
      market_cap: 1e9,
      total_volume: 1e8,
      sparkline_in_7d: { price: [1] },
    }))
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => payload })
      .mockRejectedValue(new Error('down'))
    vi.stubGlobal('fetch', fetchMock)
    const store = useMarketStore()
    await store.fetchTickers()
    await store.fetchTickers() // 2回目は失敗
    expect(store.usingMockData).toBe(false)
    expect(store.tickerOf('bitcoin')?.priceUsd).toBe(500)
    expect(store.lastError).not.toBe('')
    vi.unstubAllGlobals()
  })
})

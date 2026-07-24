import { describe, expect, it } from 'vitest'
import { computeEntryRanges, decideTrade, fallbackInsight } from '~/shared/advisor'
import { decideDegenTrade } from '~/shared/degenAdvisor'
import { mockSolanaTokens, mockTickers } from '~/shared/mockData'
import { STRATEGY_PRESETS } from '~/shared/strategyPresets'
import { applyDecision, createPortfolio } from '~/shared/tradeEngine'

/**
 * 結合テスト: アドバイザー（判断）× トレードエンジン（執行）の連携。
 * AI フォールバック経路（BR-5）が実際に注文まで一気通貫で流れることを検証する。
 */
describe('アドバイザー × トレードエンジン結合', () => {
  const tickers = mockTickers(42)
  const strategy = STRATEGY_PRESETS[0]

  it('fallbackInsight: 全銘柄・全時間軸で妥当な出力を返す（BR-4: 理由とソース付き）', () => {
    for (const t of tickers) {
      for (const horizon of ['short', 'mid', 'long'] as const) {
        const ins = fallbackInsight(t, horizon)
        expect(['bullish', 'neutral', 'bearish']).toContain(ins.stance)
        expect(ins.confidence).toBeGreaterThanOrEqual(20)
        expect(ins.confidence).toBeLessThanOrEqual(85)
        expect(ins.reasons.length).toBeGreaterThan(0)
        expect(ins.risks.length).toBeGreaterThan(0)
        expect(ins.sources.length).toBeGreaterThan(0)
        expect(ins.engine).toBe('fallback')
      }
    }
  })

  it('computeEntryRanges: ロングは現値未満・ショートは現値超、いずれも min < max', () => {
    for (const t of tickers) {
      const ranges = computeEntryRanges(t)
      expect(ranges.long.minUsd).toBeLessThan(ranges.long.maxUsd)
      expect(ranges.long.maxUsd).toBeLessThan(t.priceUsd)
      expect(ranges.short.minUsd).toBeLessThan(ranges.short.maxUsd)
      expect(ranges.short.minUsd).toBeGreaterThan(t.priceUsd)
      expect(ranges.long.note.length).toBeGreaterThan(0)
      expect(ranges.short.note.length).toBeGreaterThan(0)
    }
  })

  it('fallbackInsight: entryRanges が常に付与される', () => {
    const ins = fallbackInsight(tickers[0], 'short')
    expect(ins.entryRanges).toBeDefined()
    expect(ins.entryRanges!.long.maxUsd).toBeGreaterThan(0)
  })

  it('decideTrade の判断が applyDecision で執行できる', () => {
    let portfolio = createPortfolio(10_000)
    const prices = Object.fromEntries(tickers.map((t) => [t.assetId, t.priceUsd]))
    let executed = 0
    for (const t of tickers) {
      const decision = decideTrade(t, { strategy, exposureRatio: 0, unrealizedPct: null })
      expect(decision.reason.length).toBeGreaterThan(0)
      const result = applyDecision(portfolio, decision, {
        assetId: t.assetId,
        priceUsd: t.priceUsd,
        strategy: strategy.name,
        prices,
      })
      if (result) {
        portfolio = result.portfolio
        executed++
        expect(result.order.reason).toBe(decision.reason)
        expect(result.order.strategy).toBe(strategy.name)
      }
    }
    // モックデータには上昇銘柄が含まれるため、少なくとも1件は執行される
    expect(executed).toBeGreaterThan(0)
    expect(portfolio.cashUsd).toBeLessThan(10_000)
    expect(portfolio.orders).toHaveLength(executed)
  })

  it('損切りルール: 大きな含み損では必ず sell 全量', () => {
    const t = tickers[0]
    const decision = decideTrade(t, { strategy, exposureRatio: 0.2, unrealizedPct: -25 })
    expect(decision.action).toBe('sell')
    expect(decision.sizeRatio).toBe(1)
  })

  it('利確ルール: 大きな含み益では一部利確', () => {
    const t = tickers[0]
    const decision = decideTrade(t, { strategy, exposureRatio: 0.2, unrealizedPct: 40 })
    expect(decision.action).toBe('sell')
    expect(decision.sizeRatio).toBe(0.5)
  })

  it('decideDegenTrade: -30% で全量損切り・+100% で半分利確（魔界ルール）', () => {
    const token = mockSolanaTokens(7)[0]
    const degen = STRATEGY_PRESETS.find((p) => p.id === 'preset-degen-ladder')!
    const cut = decideDegenTrade(token, { strategy: degen, unrealizedPct: -35, exposureRatio: 0.05 })
    expect(cut.action).toBe('sell')
    expect(cut.sizeRatio).toBe(1)
    const take = decideDegenTrade(
      { ...token, liquidityUsd: 500_000, volume24hUsd: 800_000, ageHours: 100, change24hPct: 30 },
      { strategy: degen, unrealizedPct: 120, exposureRatio: 0.05 },
    )
    expect(take.action).toBe('sell')
    expect(take.sizeRatio).toBe(0.5)
  })
})

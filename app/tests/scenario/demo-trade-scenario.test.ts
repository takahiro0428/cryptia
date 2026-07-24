import { describe, expect, it } from 'vitest'
import { decideTrade } from '~/shared/advisor'
import { mockTickers } from '~/shared/mockData'
import { STRATEGY_PRESETS } from '~/shared/strategyPresets'
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
import type { Portfolio, Ticker } from '~/shared/types'

/**
 * シナリオテスト（UC-4 / UC-5 のユーザーストーリーを通し実行）。
 * 「山田さんが初期資金を設定して AI デモトレードを開始し、
 *  注文履歴とサマリーで結果を振り返る」までの全データフローを検証する。
 */

/** 価格系列を進めたティッカーを生成する */
function advanceTicker(base: Ticker, factor: number): Ticker {
  const price = base.priceUsd * factor
  const spark = [...base.sparkline7d.slice(1), price]
  return { ...base, priceUsd: price, sparkline7d: spark, change24hPct: (factor - 1) * 100 }
}

describe('シナリオ: AI デモトレードの一連の流れ（UC-4）', () => {
  it('開始 → 自動売買ティック → 損益確定 → サマリー確認', () => {
    const strategy = STRATEGY_PRESETS[0] // 順張りモメンタム
    const tickers = mockTickers(42).slice(0, 3)
    let portfolio: Portfolio = createPortfolio(10_000, 0)

    // 20 ティックの自動売買。押し目を挟む強い上昇相場 → 急落のシナリオ
    // （上昇局面で買いシグナル、急落局面で損切りシグナルが確実に発生する系列）
    const factors = [1.05, 0.99, 1.06, 0.995, 1.07, 0.99, 1.06, 1.0, 1.05, 0.99, 1.06, 0.98, 0.88, 0.9, 0.92, 0.95, 1.0, 1.01, 0.99, 1.0]
    let current = tickers
    factors.forEach((factor, tickIndex) => {
      current = current.map((t) => advanceTicker(t, factor))
      const prices = Object.fromEntries(current.map((t) => [t.assetId, t.priceUsd]))
      for (const t of current) {
        const equity = portfolioEquity(portfolio, prices)
        const pos = positionOf(portfolio, t.assetId)
        const exposureRatio = equity > 0 ? ((pos?.quantity ?? 0) * t.priceUsd) / equity : 0
        const unrealizedPct =
          pos && pos.avgCostUsd > 0 ? ((t.priceUsd - pos.avgCostUsd) / pos.avgCostUsd) * 100 : null
        const decision = decideTrade(t, { strategy, exposureRatio, unrealizedPct })
        const result = applyDecision(portfolio, decision, {
          assetId: t.assetId,
          priceUsd: t.priceUsd,
          strategy: strategy.name,
          prices,
          at: tickIndex,
        })
        if (result) portfolio = result.portfolio
      }
      portfolio = recordEquity(portfolio, prices, tickIndex + 1)
    })

    const prices = Object.fromEntries(current.map((t) => [t.assetId, t.priceUsd]))
    const summary = summarize(portfolio, prices)

    // 検証: 注文が発生し、全注文に判断理由と戦略名が付与されている（BR-4）
    expect(portfolio.orders.length).toBeGreaterThan(0)
    for (const order of portfolio.orders) {
      expect(order.reason.length).toBeGreaterThan(0)
      expect(order.strategy).toBe(strategy.name)
      expect(order.notionalUsd).toBeGreaterThan(0)
    }

    // 検証: 資産推移が記録され、収支が整合する（現金 + ポジション = equity）
    expect(portfolio.equityCurve.length).toBeGreaterThan(1)
    const positionsValue = portfolio.positions.reduce(
      (s, p) => s + p.quantity * (prices[p.assetId] ?? 0),
      0,
    )
    expect(summary.equityUsd).toBeCloseTo(portfolio.cashUsd + positionsValue, 6)

    // 検証: サマリー統計の整合性
    expect(summary.tradeCount).toBe(portfolio.orders.length)
    const sells = portfolio.orders.filter((o) => o.side === 'sell')
    expect(summary.winCount + summary.lossCount).toBeLessThanOrEqual(sells.length)
    expect(summary.maxDrawdownPct).toBeGreaterThanOrEqual(0)

    // 検証: 現金がマイナスにならない（資金管理の破綻がない）
    expect(portfolio.cashUsd).toBeGreaterThanOrEqual(0)
  })
})

describe('シナリオ: Solana 魔界ラダー取引（UC-5）', () => {
  it('等分エントリー → +100%で50%利確 → +300%で追加利確 → 暴落で損切り', () => {
    let portfolio = createPortfolio(1_000, 0)
    const entry = 0.001
    // 2トークンに等分エントリー
    for (const addr of ['PAIR-A', 'PAIR-B']) {
      portfolio = executeOrder(portfolio, {
        assetId: addr,
        side: 'buy',
        notionalUsd: 500,
        priceUsd: entry,
        reason: 'ラダー初期エントリー',
        strategy: 'ラダーロジック',
        at: 0,
      }).portfolio
    }
    const triggered: Record<string, number[]> = { 'PAIR-A': [], 'PAIR-B': [] }

    // PAIR-A が +120% に上昇 → +100% ルール（50%利確）のみ発動
    let fired = checkLadder(entry, entry * 2.2, DEFAULT_LADDER_RULES, triggered['PAIR-A'])
    expect(fired.map((f) => f.rule.triggerPct)).toEqual([100])
    for (const { index, rule } of fired) {
      const pos = positionOf(portfolio, 'PAIR-A')!
      portfolio = executeOrder(portfolio, {
        assetId: 'PAIR-A',
        side: 'sell',
        notionalUsd: pos.quantity * rule.sellRatio * entry * 2.2,
        priceUsd: entry * 2.2,
        reason: `ラダー利確 +${rule.triggerPct}%`,
        strategy: 'ラダーロジック',
        at: 1,
      }).portfolio
      triggered['PAIR-A'].push(index)
    }
    // 半分利確で元本超の回収（$500 投入 → $550 回収）
    const takeProfits = portfolio.orders.filter((o) => o.side === 'sell')
    expect(takeProfits[0].notionalUsd).toBeCloseTo(550, 0)
    expect(takeProfits[0].realizedPnlUsd).toBeGreaterThan(0)

    // さらに +320% → +300% ルールが発動（+100% は発動済みでスキップ）
    fired = checkLadder(entry, entry * 4.2, DEFAULT_LADDER_RULES, triggered['PAIR-A'])
    expect(fired.map((f) => f.rule.triggerPct)).toEqual([300])

    // PAIR-B は -35% に暴落 → 全量損切り
    fired = checkLadder(entry, entry * 0.65, DEFAULT_LADDER_RULES, triggered['PAIR-B'])
    expect(fired).toHaveLength(1)
    const cutRule = fired[0].rule
    expect(cutRule.sellRatio).toBe(1)
    const posB = positionOf(portfolio, 'PAIR-B')!
    portfolio = executeOrder(portfolio, {
      assetId: 'PAIR-B',
      side: 'sell',
      notionalUsd: posB.quantity * cutRule.sellRatio * entry * 0.65,
      priceUsd: entry * 0.65,
      reason: `ラダー損切り ${cutRule.triggerPct}%`,
      strategy: 'ラダーロジック',
      at: 2,
    }).portfolio
    expect(positionOf(portfolio, 'PAIR-B')).toBeUndefined()
    const cutOrder = portfolio.orders[portfolio.orders.length - 1]
    expect(cutOrder.realizedPnlUsd).toBeLessThan(0)

    // 履歴は3注文の追記（買2 + 利確1 + 損切1 = 4）
    expect(portfolio.orders).toHaveLength(4)
  })
})

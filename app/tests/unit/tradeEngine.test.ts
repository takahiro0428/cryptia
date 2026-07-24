import { describe, expect, it } from 'vitest'
import { CryptiaError, ERROR_CODES } from '~/shared/errors'
import {
  checkLadder,
  createPortfolio,
  DEFAULT_LADDER_RULES,
  executeOrder,
  portfolioEquity,
  recordEquity,
  summarize,
} from '~/shared/tradeEngine'

const base = { reason: 'test', strategy: 'test-strategy', at: 1000 }

describe('デモトレードエンジン（shared/tradeEngine）', () => {
  it('createPortfolio: 初期資金で作成。不正値は INVALID_INPUT', () => {
    const p = createPortfolio(10000, 1000)
    expect(p.cashUsd).toBe(10000)
    expect(p.equityCurve).toHaveLength(1)
    expect(() => createPortfolio(0)).toThrowError(CryptiaError)
    expect(() => createPortfolio(-5)).toThrowError(/初期資金/)
    expect(() => createPortfolio(Number.NaN)).toThrowError(CryptiaError)
  })

  it('買い注文: 現金が減りポジションが増える。平均取得単価を按分', () => {
    let p = createPortfolio(10000)
    p = executeOrder(p, { ...base, assetId: 'bitcoin', side: 'buy', notionalUsd: 1000, priceUsd: 100 }).portfolio
    p = executeOrder(p, { ...base, assetId: 'bitcoin', side: 'buy', notionalUsd: 1000, priceUsd: 200 }).portfolio
    expect(p.cashUsd).toBe(8000)
    const pos = p.positions[0]
    expect(pos.quantity).toBeCloseTo(15) // 10 + 5
    expect(pos.avgCostUsd).toBeCloseTo(2000 / 15)
  })

  it('残高不足の買いは INSUFFICIENT_FUNDS で拒否され、状態は変わらない', () => {
    const p = createPortfolio(100)
    expect(() =>
      executeOrder(p, { ...base, assetId: 'bitcoin', side: 'buy', notionalUsd: 500, priceUsd: 100 }),
    ).toThrowError(expect.objectContaining({ code: ERROR_CODES.INSUFFICIENT_FUNDS }))
    expect(p.cashUsd).toBe(100)
    expect(p.orders).toHaveLength(0)
  })

  it('売り注文: 実現損益を計算し、全量売却でポジションが消える', () => {
    let p = createPortfolio(10000)
    p = executeOrder(p, { ...base, assetId: 'solana', side: 'buy', notionalUsd: 1000, priceUsd: 100 }).portfolio
    const { portfolio: p2, order } = executeOrder(p, {
      ...base,
      assetId: 'solana',
      side: 'sell',
      notionalUsd: 1500,
      priceUsd: 150,
    })
    expect(order.realizedPnlUsd).toBeCloseTo(500)
    expect(p2.positions).toHaveLength(0)
    expect(p2.cashUsd).toBeCloseTo(10500)
  })

  it('保有数量を超える売りは INSUFFICIENT_POSITION', () => {
    let p = createPortfolio(10000)
    p = executeOrder(p, { ...base, assetId: 'solana', side: 'buy', notionalUsd: 1000, priceUsd: 100 }).portfolio
    expect(() =>
      executeOrder(p, { ...base, assetId: 'solana', side: 'sell', notionalUsd: 2000, priceUsd: 100 }),
    ).toThrowError(expect.objectContaining({ code: ERROR_CODES.INSUFFICIENT_POSITION }))
  })

  it('注文履歴は追記型で元オブジェクトを変更しない（BR-7）', () => {
    const p1 = createPortfolio(10000)
    const { portfolio: p2 } = executeOrder(p1, {
      ...base,
      assetId: 'bitcoin',
      side: 'buy',
      notionalUsd: 100,
      priceUsd: 50,
    })
    expect(p1.orders).toHaveLength(0)
    expect(p2.orders).toHaveLength(1)
  })

  it('portfolioEquity: 現金 + 時価評価', () => {
    let p = createPortfolio(10000)
    p = executeOrder(p, { ...base, assetId: 'bitcoin', side: 'buy', notionalUsd: 1000, priceUsd: 100 }).portfolio
    expect(portfolioEquity(p, { bitcoin: 120 })).toBeCloseTo(9000 + 10 * 120)
  })

  it('summarize: 勝率・最大ドローダウンを計算', () => {
    let p = createPortfolio(1000)
    p = executeOrder(p, { ...base, assetId: 'bitcoin', side: 'buy', notionalUsd: 500, priceUsd: 100, at: 1 }).portfolio
    p = executeOrder(p, { ...base, assetId: 'bitcoin', side: 'sell', notionalUsd: 300, priceUsd: 120, at: 2 }).portfolio
    p = recordEquity(p, { bitcoin: 60 }, 3) // 含み損でドローダウン発生
    const s = summarize(p, { bitcoin: 60 })
    expect(s.winCount).toBe(1)
    expect(s.winRatePct).toBe(100)
    expect(s.maxDrawdownPct).toBeGreaterThan(0)
    expect(s.tradeCount).toBe(2)
  })

  it('checkLadder: +100% で 50% 利確ルールが発動し、発動済みは再発動しない', () => {
    const fired = checkLadder(1, 2.1, DEFAULT_LADDER_RULES, [])
    expect(fired).toHaveLength(1)
    expect(fired[0].rule.triggerPct).toBe(100)
    // 発動済み
    expect(checkLadder(1, 2.1, DEFAULT_LADDER_RULES, [0])).toHaveLength(0)
  })

  it('checkLadder: -30% で損切りルールが発動する', () => {
    const fired = checkLadder(1, 0.65, DEFAULT_LADDER_RULES, [])
    expect(fired).toHaveLength(1)
    expect(fired[0].rule.triggerPct).toBe(-30)
    expect(fired[0].rule.sellRatio).toBe(1)
  })

  it('checkLadder: +300% では複数ルールがトリガー率昇順で発動する', () => {
    const fired = checkLadder(1, 4.2, DEFAULT_LADDER_RULES, [])
    expect(fired.map((f) => f.rule.triggerPct)).toEqual([100, 300])
  })
})

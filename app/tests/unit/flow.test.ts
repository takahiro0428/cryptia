import { describe, expect, it } from 'vitest'
import { estimateFlows, netFlowByAsset } from '~/shared/flow'
import type { Ticker } from '~/shared/types'

function ticker(assetId: string, change24hPct: number, volume24hUsd: number): Ticker {
  return {
    assetId,
    priceUsd: 100,
    change1hPct: change24hPct / 24,
    change24hPct,
    change7dPct: change24hPct * 3,
    marketCapUsd: volume24hUsd * 10,
    volume24hUsd,
    sparkline7d: [],
    updatedAt: 0,
  }
}

describe('資金フロー推定（shared/flow）', () => {
  it('下落銘柄から上昇銘柄へのフローを生成する', () => {
    const flows = estimateFlows(
      [ticker('bitcoin', -5, 1e9), ticker('solana', 8, 5e8)],
      '24h',
    )
    expect(flows.length).toBeGreaterThan(0)
    expect(flows[0].fromAssetId).toBe('bitcoin')
    expect(flows[0].toAssetId).toBe('solana')
    expect(flows[0].amountUsd).toBeGreaterThan(0)
  })

  it('全銘柄が同方向（全上昇）の場合はフローなし', () => {
    const flows = estimateFlows([ticker('a', 5, 1e8), ticker('b', 3, 1e8)], '24h')
    expect(flows).toHaveLength(0)
  })

  it('銘柄が1つ以下の場合は空', () => {
    expect(estimateFlows([ticker('a', 5, 1e8)], '24h')).toHaveLength(0)
    expect(estimateFlows([], '24h')).toHaveLength(0)
  })

  it('期間の切替で参照する騰落率が変わる', () => {
    // 1h では下落・7d では上昇という銘柄
    const t = {
      ...ticker('bitcoin', 0, 1e9),
      change1hPct: -3,
      change7dPct: 10,
    }
    const other = ticker('solana', 2, 5e8) // 1h では +0.083 → 流入側
    const flows1h = estimateFlows([t, other], '1h')
    const flows7d = estimateFlows([t, other], '7d')
    expect(flows1h.some((f) => f.fromAssetId === 'bitcoin')).toBe(true)
    expect(flows7d.some((f) => f.fromAssetId === 'bitcoin')).toBe(false)
  })

  it('フロー本数は描画上限（24本）以内', () => {
    const many = Array.from({ length: 20 }, (_, i) =>
      ticker(`asset-${i}`, i % 2 === 0 ? 5 : -5, 1e8 + i * 1e7),
    )
    expect(estimateFlows(many, '24h').length).toBeLessThanOrEqual(24)
  })

  it('netFlowByAsset: 流入・流出を銘柄別に集計する', () => {
    const flows = [
      { fromAssetId: 'a', toAssetId: 'b', amountUsd: 100 },
      { fromAssetId: 'c', toAssetId: 'b', amountUsd: 50 },
      { fromAssetId: 'b', toAssetId: 'a', amountUsd: 30 },
    ]
    const net = netFlowByAsset(flows)
    expect(net.get('b')).toEqual({ inUsd: 150, outUsd: 30 })
    expect(net.get('a')).toEqual({ inUsd: 30, outUsd: 100 })
  })
})

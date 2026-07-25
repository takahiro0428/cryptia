import { describe, expect, it } from 'vitest'
import { buildFlowMatrix, estimateFlows, heuristicNetUsd, netFlowByAsset } from '~/shared/flow'
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

  it('buildFlowMatrix: 実測ネットフローを流出→流入へ比例配分する', () => {
    const flows = buildFlowMatrix([
      { assetId: 'btc', netUsd: -1000, measured: true },
      { assetId: 'eth', netUsd: 600, measured: true },
      { assetId: 'sol', netUsd: 400, measured: true },
    ])
    // 流出合計 1000 / 流入合計 1000 → moved = 1000 が 6:4 で配分される
    const toEth = flows.find((f) => f.toAssetId === 'eth')
    const toSol = flows.find((f) => f.toAssetId === 'sol')
    expect(toEth?.amountUsd).toBeCloseTo(600)
    expect(toSol?.amountUsd).toBeCloseTo(400)
    expect(flows.every((f) => f.fromAssetId === 'btc')).toBe(true)
  })

  it('buildFlowMatrix: 流入・流出の少ない方まででフロー総量が制限される', () => {
    const flows = buildFlowMatrix([
      { assetId: 'a', netUsd: -10_000, measured: true },
      { assetId: 'b', netUsd: 2_000, measured: true },
    ])
    const total = flows.reduce((s, f) => s + f.amountUsd, 0)
    expect(total).toBeCloseTo(2_000)
  })

  it('buildFlowMatrix: 片方向のみ・空は空配列', () => {
    expect(buildFlowMatrix([{ assetId: 'a', netUsd: 100, measured: true }])).toHaveLength(0)
    expect(buildFlowMatrix([])).toHaveLength(0)
  })

  it('heuristicNetUsd: 騰落率の符号がネットフローの符号になる', () => {
    const up = ticker('x', 10, 1e8)
    const down = ticker('y', -10, 1e8)
    expect(heuristicNetUsd(up, '24h')).toBeGreaterThan(0)
    expect(heuristicNetUsd(down, '24h')).toBeLessThan(0)
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

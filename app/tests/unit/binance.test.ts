import { describe, expect, it } from 'vitest'
import { ASSETS } from '~/shared/assets'
import {
  BINANCE_SYMBOL_TO_ASSET,
  BINANCE_SYMBOLS,
  KLINE_PARAMS,
  netTakerFlowUsd,
  parseMiniTicker,
} from '~/shared/binance'

describe('Binance 連携（shared/binance）', () => {
  it('銘柄マスタの全銘柄がシンボルマップに定義されている（null 許容）', () => {
    for (const asset of ASSETS) {
      expect(BINANCE_SYMBOLS).toHaveProperty(asset.id)
    }
  })

  it('逆引きマップはシンボル定義と整合する', () => {
    for (const [sym, assetId] of Object.entries(BINANCE_SYMBOL_TO_ASSET)) {
      expect(BINANCE_SYMBOLS[assetId]?.toLowerCase()).toBe(sym)
    }
  })

  it('netTakerFlowUsd: テイカー買い優勢はプラス、売り優勢はマイナス', () => {
    // kline: index7 = quoteVolume, index10 = takerBuyQuoteVol
    const buyHeavy = [[0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 800]]
    const sellHeavy = [[0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 200]]
    expect(netTakerFlowUsd(buyHeavy)).toBe(600) // 800買い - 200売り
    expect(netTakerFlowUsd(sellHeavy)).toBe(-600)
    expect(netTakerFlowUsd([])).toBe(0)
  })

  it('netTakerFlowUsd: 不正データ行はスキップする', () => {
    const rows = [
      [0, 0, 0, 0, 0, 0, 0, 'x', 0, 0, 500],
      [0, 0, 0, 0, 0, 0, 0, 1000, 0, 0, 700],
    ]
    expect(netTakerFlowUsd(rows as unknown[][])).toBe(400)
  })

  it('parseMiniTicker: 価格と24h騰落率を返す。未知シンボル・不正値は null', () => {
    const tick = parseMiniTicker({ s: 'BTCUSDT', c: '110000', o: '100000' })
    expect(tick?.assetId).toBe('bitcoin')
    expect(tick?.priceUsd).toBe(110000)
    expect(tick?.change24hPct).toBeCloseTo(10)
    expect(parseMiniTicker({ s: 'UNKNOWNUSDT', c: '1', o: '1' })).toBeNull()
    expect(parseMiniTicker({ s: 'BTCUSDT', c: '-5', o: '1' })).toBeNull()
    expect(parseMiniTicker(undefined)).toBeNull()
  })

  it('KLINE_PARAMS: 全期間が定義されている', () => {
    expect(KLINE_PARAMS['1h']).toEqual({ interval: '5m', limit: 12 })
    expect(KLINE_PARAMS['24h']).toEqual({ interval: '1h', limit: 24 })
    expect(KLINE_PARAMS['7d']).toEqual({ interval: '1d', limit: 7 })
  })
})

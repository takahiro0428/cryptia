import { describe, expect, it } from 'vitest'
import { clamp, ema, momentum, rsi, sma, volatility } from '~/shared/ta'

describe('テクニカル指標（shared/ta）', () => {
  it('sma: 期間分の単純平均を返す', () => {
    expect(sma([1, 2, 3, 4], 2)).toBe(3.5)
    expect(sma([1, 2, 3, 4], 10)).toBe(2.5) // 期間不足時は全体平均
    expect(sma([], 5)).toBe(0)
  })

  it('ema: データ末尾に重みを置く', () => {
    const values = [1, 1, 1, 1, 10]
    expect(ema(values, 3)).toBeGreaterThan(sma(values, 5))
  })

  it('rsi: 一方向の上昇で 100 に近づき、下落で 0 に近づく', () => {
    const rising = Array.from({ length: 20 }, (_, i) => 100 + i)
    const falling = Array.from({ length: 20 }, (_, i) => 100 - i)
    expect(rsi(rising)).toBeGreaterThan(90)
    expect(rsi(falling)).toBeLessThan(10)
  })

  it('rsi: データ不足・変動なしは 50（中立）', () => {
    expect(rsi([1, 2, 3])).toBe(50)
    expect(rsi(Array(20).fill(100))).toBe(50)
  })

  it('momentum: 指定期間の変化率（%）', () => {
    const values = [100, 105, 110]
    expect(momentum(values, 2)).toBeCloseTo(10)
    expect(momentum([100], 5)).toBe(0)
  })

  it('volatility: 変動が大きいほど大きい', () => {
    const calm = [100, 100.1, 100.2, 100.1, 100.3]
    const wild = [100, 90, 110, 85, 120]
    expect(volatility(wild)).toBeGreaterThan(volatility(calm))
    expect(volatility([1, 2])).toBe(0)
  })

  it('clamp: 範囲内に丸める', () => {
    expect(clamp(5, 0, 10)).toBe(5)
    expect(clamp(-1, 0, 10)).toBe(0)
    expect(clamp(11, 0, 10)).toBe(10)
  })
})

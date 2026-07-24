import { describe, expect, it } from 'vitest'
import { fmtPct, fmtQty, fmtUsd } from '~/shared/format'

describe('表示フォーマット（shared/format）', () => {
  it('fmtUsd: 桁に応じた表記', () => {
    expect(fmtUsd(2_300_000_000)).toBe('$2.30B')
    expect(fmtUsd(4_500_000)).toBe('$4.50M')
    expect(fmtUsd(12345)).toBe('$12,345')
    expect(fmtUsd(12.3456)).toBe('$12.35')
    expect(fmtUsd(0.1234)).toBe('$0.1234')
    expect(fmtUsd(0.00001234)).toBe('$0.0000123')
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(Number.NaN)).toBe('—')
  })

  it('fmtPct: 符号付き', () => {
    expect(fmtPct(5.678)).toBe('+5.68%')
    expect(fmtPct(-3.2)).toBe('-3.20%')
    expect(fmtPct(Number.NaN)).toBe('—')
  })

  it('fmtQty: 桁に応じた精度', () => {
    expect(fmtQty(1234.5)).toBe('1,235')
    expect(fmtQty(1.23456)).toBe('1.2346')
    expect(fmtQty(0.00012345)).toBe('0.0001234')
  })
})

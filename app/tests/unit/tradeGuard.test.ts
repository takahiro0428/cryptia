import { describe, expect, it } from 'vitest'
import { ERROR_CODES } from '~/shared/errors'
import { assertTradeAllowed, canEnableAutoTrade, DEFAULT_GUARD } from '~/shared/tradeGuard'
import type { TradeGuardConfig } from '~/shared/types'

const readyGuard: TradeGuardConfig = {
  riskConsentAt: 1000,
  maxPerTradeUsd: 100,
  maxPerDayUsd: 300,
  autoTradeEnabled: true,
}

describe('実トレード安全ガード（shared/tradeGuard）', () => {
  it('デフォルトでは自動取引を有効化できない（BR-2）', () => {
    expect(canEnableAutoTrade(DEFAULT_GUARD)).toBe(false)
  })

  it('同意 + 上限設定が揃うと有効化可能', () => {
    expect(canEnableAutoTrade(readyGuard)).toBe(true)
    expect(canEnableAutoTrade({ ...readyGuard, riskConsentAt: null })).toBe(false)
    expect(canEnableAutoTrade({ ...readyGuard, maxPerTradeUsd: 0 })).toBe(false)
    expect(canEnableAutoTrade({ ...readyGuard, maxPerDayUsd: 0 })).toBe(false)
  })

  it('リスク未同意の取引は TRADE_GUARD_BLOCKED', () => {
    expect(() => assertTradeAllowed(DEFAULT_GUARD, 10, 0, { auto: false })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.TRADE_GUARD_BLOCKED }),
    )
  })

  it('自動取引は autoTradeEnabled が false なら拒否', () => {
    const guard = { ...readyGuard, autoTradeEnabled: false }
    expect(() => assertTradeAllowed(guard, 10, 0, { auto: true })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.TRADE_GUARD_BLOCKED }),
    )
    // 手動なら許可
    expect(() => assertTradeAllowed(guard, 10, 0, { auto: false })).not.toThrow()
  })

  it('1回あたり上限超過は TRADE_LIMIT_EXCEEDED', () => {
    expect(() => assertTradeAllowed(readyGuard, 150, 0, { auto: false })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.TRADE_LIMIT_EXCEEDED }),
    )
  })

  it('1日あたり上限超過は TRADE_LIMIT_EXCEEDED（当日消費を加算して判定）', () => {
    expect(() => assertTradeAllowed(readyGuard, 100, 250, { auto: false })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.TRADE_LIMIT_EXCEEDED }),
    )
    expect(() => assertTradeAllowed(readyGuard, 50, 250, { auto: false })).not.toThrow()
  })

  it('不正金額は INVALID_INPUT', () => {
    expect(() => assertTradeAllowed(readyGuard, 0, 0, { auto: false })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    )
    expect(() => assertTradeAllowed(readyGuard, Number.NaN, 0, { auto: false })).toThrowError(
      expect.objectContaining({ code: ERROR_CODES.INVALID_INPUT }),
    )
  })
})

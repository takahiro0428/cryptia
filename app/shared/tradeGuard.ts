import { CryptiaError, ERROR_CODES } from './errors'
import type { TradeGuardConfig } from './types'

/**
 * 実トレードの安全ガード（BR-2）。
 * AI 自動実トレードは「リスク同意 + 上限設定」の両方が揃うまで有効化できず、
 * 上限超過の注文はエラーコード付きで拒否する。
 */

export const DEFAULT_GUARD: TradeGuardConfig = {
  riskConsentAt: null,
  maxPerTradeUsd: 0,
  maxPerDayUsd: 0,
  autoTradeEnabled: false,
}

/** 自動実トレードを有効化できる状態か */
export function canEnableAutoTrade(config: TradeGuardConfig): boolean {
  return config.riskConsentAt !== null && config.maxPerTradeUsd > 0 && config.maxPerDayUsd > 0
}

/**
 * 実トレード注文（手動・自動共通）の事前チェック。
 * @param todaysSpentUsd 当日すでに約定した合計金額
 * @throws CryptiaError TRADE_GUARD_BLOCKED / TRADE_LIMIT_EXCEEDED / INVALID_INPUT
 */
export function assertTradeAllowed(
  config: TradeGuardConfig,
  notionalUsd: number,
  todaysSpentUsd: number,
  opts: { auto: boolean },
): void {
  if (!Number.isFinite(notionalUsd) || notionalUsd <= 0) {
    throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '取引金額は正の数値で指定してください')
  }
  // 当日消費が NaN 等の場合、比較が常に false になり上限ガードが無効化されるため
  // 安全側（拒否）に倒す（AUDIT-11: 多層防御の最終段）
  if (!Number.isFinite(todaysSpentUsd) || todaysSpentUsd < 0) {
    throw new CryptiaError(
      ERROR_CODES.INVALID_INPUT,
      '当日の取引実績を検証できないため注文を拒否しました（取引履歴の破損の可能性があります）',
    )
  }
  if (config.riskConsentAt === null) {
    throw new CryptiaError(
      ERROR_CODES.TRADE_GUARD_BLOCKED,
      '実トレードにはリスク説明への同意が必要です',
      false,
    )
  }
  if (opts.auto) {
    if (!config.autoTradeEnabled || !canEnableAutoTrade(config)) {
      throw new CryptiaError(
        ERROR_CODES.TRADE_GUARD_BLOCKED,
        'AI 自動実トレードが有効化されていません（リスク同意と取引上限の設定が必要です）',
        false,
      )
    }
  }
  // 上限が設定されている場合は手動取引にも適用する（誤操作防止）
  if (config.maxPerTradeUsd > 0 && notionalUsd > config.maxPerTradeUsd) {
    throw new CryptiaError(
      ERROR_CODES.TRADE_LIMIT_EXCEEDED,
      `1回あたりの取引上限（$${config.maxPerTradeUsd}）を超えています`,
    )
  }
  if (config.maxPerDayUsd > 0 && todaysSpentUsd + notionalUsd > config.maxPerDayUsd) {
    throw new CryptiaError(
      ERROR_CODES.TRADE_LIMIT_EXCEEDED,
      `1日あたりの取引上限（$${config.maxPerDayUsd}）を超えるため注文できません`,
    )
  }
}

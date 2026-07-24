/**
 * テクニカル分析ユーティリティ（純関数）。
 * AI フォールバック分析・デモトレード判断・テストで共用する。
 */

/** 単純移動平均。期間に満たない場合は先頭からの平均 */
export function sma(values: number[], period: number): number {
  if (values.length === 0) return 0
  const slice = values.slice(-period)
  return slice.reduce((s, v) => s + v, 0) / slice.length
}

/** 指数移動平均 */
export function ema(values: number[], period: number): number {
  if (values.length === 0) return 0
  const k = 2 / (period + 1)
  let result = values[0]
  for (let i = 1; i < values.length; i++) {
    result = values[i] * k + result * (1 - k)
  }
  return result
}

/** RSI（Wilder 平滑化の簡易版）。データ不足時は 50（中立） */
export function rsi(values: number[], period = 14): number {
  if (values.length < period + 1) return 50
  let gain = 0
  let loss = 0
  for (let i = values.length - period; i < values.length; i++) {
    const diff = values[i] - values[i - 1]
    if (diff >= 0) gain += diff
    else loss -= diff
  }
  if (gain + loss === 0) return 50
  const rs = loss === 0 ? Number.POSITIVE_INFINITY : gain / loss
  return 100 - 100 / (1 + rs)
}

/** 直近 n 点の変化率（%） */
export function momentum(values: number[], lookback: number): number {
  if (values.length < 2) return 0
  const idx = Math.max(0, values.length - 1 - lookback)
  const base = values[idx]
  if (base === 0) return 0
  return ((values[values.length - 1] - base) / base) * 100
}

/** 変動率の標準偏差（%）。リスク指標として使用 */
export function volatility(values: number[]): number {
  if (values.length < 3) return 0
  const returns: number[] = []
  for (let i = 1; i < values.length; i++) {
    if (values[i - 1] !== 0) returns.push((values[i] - values[i - 1]) / values[i - 1])
  }
  if (returns.length === 0) return 0
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length
  return Math.sqrt(variance) * 100
}

/** 値を [min, max] に丸める */
export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

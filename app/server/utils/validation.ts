import { createError } from 'h3'
import { isKnownAssetId } from '~/shared/assets'
import { ERROR_CODES } from '~/shared/errors'
import type { Horizon, StrategyDoc, Ticker } from '~/shared/types'

/**
 * サーバー API 入力検証（NFR: 全入力を検証）。
 * 不正入力は 400 + エラーコードで拒否する。
 */

export function badRequest(message: string): never {
  throw createError({
    statusCode: 400,
    statusMessage: `${ERROR_CODES.INVALID_INPUT}: ${message}`,
  })
}

export function validateAssetId(value: unknown): string {
  if (typeof value !== 'string' || !isKnownAssetId(value)) {
    badRequest('assetId が不正です')
  }
  return value
}

const HORIZONS: Horizon[] = ['short', 'mid', 'long']
export function validateHorizon(value: unknown): Horizon {
  if (typeof value !== 'string' || !HORIZONS.includes(value as Horizon)) {
    badRequest('horizon は short / mid / long のいずれかを指定してください')
  }
  return value as Horizon
}

function finiteNumber(v: unknown, name: string, { min, max }: { min?: number; max?: number } = {}): number {
  const n = typeof v === 'number' ? v : NaN
  if (!Number.isFinite(n)) badRequest(`${name} が数値ではありません`)
  if (min !== undefined && n < min) badRequest(`${name} が下限（${min}）未満です`)
  if (max !== undefined && n > max) badRequest(`${name} が上限（${max}）超過です`)
  return n
}

/** クライアントから渡されるティッカーの検証（AI 分析の入力として妥当な範囲に制限） */
export function validateTicker(value: unknown): Ticker {
  if (typeof value !== 'object' || value === null) badRequest('ticker がありません')
  const t = value as Record<string, unknown>
  const assetId = validateAssetId(t.assetId)
  const sparkline = Array.isArray(t.sparkline7d) ? (t.sparkline7d as unknown[]) : []
  if (sparkline.length > 500) badRequest('sparkline7d が長すぎます')
  const spark = sparkline.map((v, i) => finiteNumber(v, `sparkline7d[${i}]`, { min: 0 }))
  return {
    assetId,
    priceUsd: finiteNumber(t.priceUsd, 'priceUsd', { min: 0 }),
    change1hPct: finiteNumber(t.change1hPct, 'change1hPct', { min: -100, max: 10000 }),
    change24hPct: finiteNumber(t.change24hPct, 'change24hPct', { min: -100, max: 10000 }),
    change7dPct: finiteNumber(t.change7dPct, 'change7dPct', { min: -100, max: 10000 }),
    marketCapUsd: finiteNumber(t.marketCapUsd, 'marketCapUsd', { min: 0 }),
    volume24hUsd: finiteNumber(t.volume24hUsd, 'volume24hUsd', { min: 0 }),
    sparkline7d: spark,
    updatedAt: Date.now(),
  }
}

/** 戦略ドキュメントの検証（プロンプト注入対策としてサイズ上限を設ける） */
export function validateStrategy(value: unknown): StrategyDoc | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'object') badRequest('strategy が不正です')
  const s = value as Record<string, unknown>
  if (typeof s.name !== 'string' || s.name.length === 0 || s.name.length > 100) {
    badRequest('strategy.name は 1〜100 文字で指定してください')
  }
  if (typeof s.content !== 'string' || s.content.length === 0 || s.content.length > 4000) {
    badRequest('strategy.content は 1〜4000 文字で指定してください')
  }
  const riskLevel = finiteNumber(s.riskLevel ?? 3, 'strategy.riskLevel', { min: 1, max: 5 })
  return {
    id: typeof s.id === 'string' ? s.id.slice(0, 64) : 'custom',
    name: s.name,
    content: s.content,
    tags: Array.isArray(s.tags) ? (s.tags as unknown[]).map(String).slice(0, 10) : [],
    builtin: Boolean(s.builtin),
    riskLevel,
    updatedAt: Date.now(),
  }
}

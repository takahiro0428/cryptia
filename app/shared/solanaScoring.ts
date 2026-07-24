import type { SolanaToken, TokenScore } from './types'
import { clamp } from './ta'

/**
 * Solana 新興トークン（草コイン・魔界トークン）のスコアリングロジック。
 * DexScreener のペア情報から「取引対象としての安全性・妙味」を 0-100 で評価する。
 * スコアは選定支援であり、投資判断の保証ではない（UI で明示する）。
 */

/** 流動性スコア: $50k 未満は大きく減点（ラグプル・スリッページリスク） */
function liquidityScore(liquidityUsd: number): number {
  if (liquidityUsd <= 0) return 0
  // $10k→18, $50k→30, $250k→50, $1M→75, $5M→100 付近の対数スケール
  return clamp(Math.round(25 * (Math.log10(liquidityUsd) - 3.3)), 0, 100)
}

/** 出来高スコア: 流動性に対する回転率で評価 */
function volumeScore(volume24hUsd: number, liquidityUsd: number): number {
  if (liquidityUsd <= 0 || volume24hUsd <= 0) return 0
  const turnover = volume24hUsd / liquidityUsd
  // 回転率 0.1→20, 0.5→50, 2→80, 5+→100
  return clamp(Math.round(35 * Math.log10(turnover * 10) + 20), 0, 100)
}

/** モメンタムスコア: 上昇は加点するが、+500% 超の垂直上げは過熱として減点 */
function momentumScore(change24hPct: number): number {
  if (change24hPct <= -50) return 0
  if (change24hPct > 500) return 30
  if (change24hPct > 200) return 55
  return clamp(Math.round(50 + change24hPct / 4), 0, 100)
}

/** 成熟度スコア: ペア年齢 24h 未満は高リスク。7日以上で満点付近 */
function maturityScore(ageHours: number): number {
  return clamp(Math.round((ageHours / (24 * 7)) * 100), 0, 100)
}

export function scoreToken(token: SolanaToken): TokenScore {
  const breakdown = {
    liquidity: liquidityScore(token.liquidityUsd),
    volume: volumeScore(token.volume24hUsd, token.liquidityUsd),
    momentum: momentumScore(token.change24hPct),
    maturity: maturityScore(token.ageHours),
  }

  const warnings: string[] = []
  if (token.liquidityUsd < 50_000) warnings.push('流動性が $50k 未満。ラグプル・スリッページリスク大')
  if (token.ageHours < 24) warnings.push('ペア作成から 24 時間未満の超新規トークン')
  if (token.change24hPct > 300) warnings.push('24h で +300% 超の垂直上昇。天井掴みに注意')
  if (token.txns24h < 100) warnings.push('取引回数が少なく、板が薄い可能性')

  // 重み: 流動性 35% / 出来高 25% / モメンタム 20% / 成熟度 20%
  const total = Math.round(
    breakdown.liquidity * 0.35 +
      breakdown.volume * 0.25 +
      breakdown.momentum * 0.2 +
      breakdown.maturity * 0.2,
  )

  return { token, total, breakdown, warnings }
}

/** 取引適格判定（戦略「魔界ラダー利確」のエントリー条件） */
export function isTradable(score: TokenScore): boolean {
  return score.token.liquidityUsd >= 50_000 && score.token.ageHours >= 24 && score.total >= 40
}

/** スコア降順に並べ、適格トークンを優先する */
export function rankTokens(tokens: SolanaToken[]): TokenScore[] {
  return tokens
    .map(scoreToken)
    .sort((a, b) => Number(isTradable(b)) - Number(isTradable(a)) || b.total - a.total)
}

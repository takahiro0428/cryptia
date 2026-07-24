import type { SolanaToken, StrategyDoc, TokenScore, TradeDecision } from './types'
import { scoreToken } from './solanaScoring'
import { clamp } from './ta'

/**
 * Solana 草コイン向けの AI 取引判断（ロジック実装）。
 * Vertex AI 未設定・障害時のフォールバックとして、またオフラインの
 * 「AI 取引」モードのローカルエンジンとして使用する（BR-5）。
 */
export function decideDegenTrade(
  token: SolanaToken,
  opts: {
    strategy: StrategyDoc
    /** ポジションの含み損益率（%）。未保有は null */
    unrealizedPct: number | null
    /** 割当資金に対する当該トークンの投入比率 */
    exposureRatio: number
  },
): TradeDecision {
  const score: TokenScore = scoreToken(token)
  const { strategy, unrealizedPct, exposureRatio } = opts

  // 出口最優先: 損切り・利確ライン（魔界の鉄則）
  if (unrealizedPct !== null) {
    if (unrealizedPct <= -30) {
      return {
        action: 'sell',
        sizeRatio: 1,
        reason: `含み損 ${unrealizedPct.toFixed(0)}% が損切りライン(-30%)に到達。全量撤退（戦略「${strategy.name}」）`,
        confidence: 90,
      }
    }
    if (score.total < 30) {
      return {
        action: 'sell',
        sizeRatio: 1,
        reason: `トークンスコアが ${score.total} まで劣化（流動性/出来高の悪化）。リスク回避で全量売却`,
        confidence: 75,
      }
    }
    if (unrealizedPct >= 100) {
      return {
        action: 'sell',
        sizeRatio: 0.5,
        reason: `含み益 +${unrealizedPct.toFixed(0)}% 到達。元本回収のため半分利確（戦略「${strategy.name}」）`,
        confidence: 85,
      }
    }
  }

  // エントリー判断: スコア + 過熱度
  const maxExposure = 0.1 // 1トークン 10% 上限（プリセット「魔界ラダー利確」のルール）
  if (score.total >= 55 && score.warnings.length <= 1 && exposureRatio < maxExposure) {
    const sizeRatio = clamp((maxExposure - exposureRatio) * (score.total / 100), 0.02, 0.1)
    return {
      action: 'buy',
      sizeRatio,
      reason: `スコア ${score.total}/100（流動性${score.breakdown.liquidity}・出来高${score.breakdown.volume}・勢い${score.breakdown.momentum}）。小口エントリー`,
      confidence: clamp(score.total, 40, 80),
    }
  }

  return {
    action: 'hold',
    sizeRatio: 0,
    reason:
      score.warnings.length > 1
        ? `警告 ${score.warnings.length} 件（${score.warnings[0]} 等）のため見送り`
        : `スコア ${score.total}/100 で基準未達。様子見`,
    confidence: 55,
  }
}

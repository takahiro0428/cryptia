import type { EntryRange, Horizon, Insight, Stance, StrategyDoc, Ticker, TradeDecision } from './types'
import { clamp, momentum, rsi, volatility } from './ta'

/**
 * テクニカル指標ベースの分析エンジン。
 * 役割は2つ:
 *  1. Vertex AI が未設定/障害時のフォールバックインサイト生成（BR-5）
 *  2. デモトレードのオフライン判断エンジン（AI 応答なしでも動作を保証）
 * 判断理由・ソースを必ず出力に含める（BR-4）。
 */

const HORIZON_LABELS: Record<Horizon, string> = {
  short: '短期（〜1週間）',
  mid: '中期（〜1ヶ月）',
  long: '長期（〜1年）',
}

interface Signal {
  score: number // -100(弱気) 〜 +100(強気)
  reasons: string[]
  risks: string[]
}

function analyzeSignals(ticker: Ticker, horizon: Horizon): Signal {
  const spark = ticker.sparkline7d
  const reasons: string[] = []
  const risks: string[] = []
  let score = 0

  const r = rsi(spark)
  const momShort = momentum(spark, 24) // 7日スパークラインの直近約1日分
  const momLong = momentum(spark, spark.length - 1)
  const vol = volatility(spark)

  // 時間軸ごとに重視する指標を変える
  const changePct =
    horizon === 'short' ? ticker.change24hPct : horizon === 'mid' ? ticker.change7dPct : momLong

  if (changePct > 2) {
    score += clamp(changePct * 2, 0, 30)
    reasons.push(`${HORIZON_LABELS[horizon]}の騰落率が +${changePct.toFixed(1)}% と上昇基調`)
  } else if (changePct < -2) {
    score += clamp(changePct * 2, -30, 0)
    reasons.push(`${HORIZON_LABELS[horizon]}の騰落率が ${changePct.toFixed(1)}% と下落基調`)
  } else {
    reasons.push('直近の値動きは横ばい圏')
  }

  if (r >= 70) {
    score -= 15
    risks.push(`RSI ${r.toFixed(0)} と買われすぎ水準。押し目リスクに注意`)
  } else if (r <= 30) {
    score += horizon === 'short' ? 15 : 8
    reasons.push(`RSI ${r.toFixed(0)} と売られすぎ水準で反発余地`)
  } else {
    reasons.push(`RSI ${r.toFixed(0)} で過熱感なし`)
  }

  if (momShort > 0 && momLong > 0) {
    score += 12
    reasons.push('短期・長期モメンタムがともにプラスで方向が一致')
  } else if (momShort < 0 && momLong < 0) {
    score -= 12
    reasons.push('短期・長期モメンタムがともにマイナス')
  }

  if (vol > 4) {
    risks.push(`ボラティリティが高め（σ=${vol.toFixed(1)}%）。ポジションサイズを抑える`)
    if (horizon === 'long') score -= 5
  }

  const volumeRatio = ticker.marketCapUsd > 0 ? ticker.volume24hUsd / ticker.marketCapUsd : 0
  if (volumeRatio > 0.15) {
    score += 5
    reasons.push('時価総額比の出来高が大きく資金流入が活発')
  } else if (volumeRatio < 0.01) {
    risks.push('出来高が薄く、値が飛びやすい')
  }

  return { score: clamp(score, -100, 100), reasons, risks }
}

/**
 * ロング/ショート別のおすすめエントリーレンジ算出。
 * - ロング: 直近サポート（24 本安値）〜 現値からボラティリティ 1σ 押した水準（押し目買いゾーン）
 * - ショート: 現値からボラティリティ 1σ 戻した水準 〜 直近レジスタンス（戻り売りゾーン）
 * Gemini 応答が欠落・不正な場合のフォールバックとしても使用する。
 */
export function computeEntryRanges(ticker: Ticker): { long: EntryRange; short: EntryRange } {
  const price = ticker.priceUsd
  const spark = ticker.sparkline7d
  const recent = spark.slice(-24)
  const recentHigh = recent.length > 0 ? Math.max(...recent) : price
  const recentLow = recent.length > 0 ? Math.min(...recent) : price
  const vol = volatility(spark)
  const nearPct = clamp(vol, 0.4, 3) // 現値からの最小乖離
  const deepPct = clamp(vol * 3, 1.5, 8) // ゾーンの最大深さ

  const longMax = price * (1 - nearPct / 100)
  const longMin = Math.min(Math.max(recentLow, price * (1 - deepPct / 100)), longMax * 0.999)
  const shortMin = price * (1 + nearPct / 100)
  const shortMax = Math.max(Math.min(Math.max(recentHigh, shortMin), price * (1 + deepPct / 100)), shortMin * 1.001)

  return {
    long: {
      minUsd: longMin,
      maxUsd: longMax,
      note: `押し目買いゾーン（直近サポート〜現値 -${nearPct.toFixed(1)}%）`,
    },
    short: {
      minUsd: shortMin,
      maxUsd: shortMax,
      note: `戻り売りゾーン（現値 +${nearPct.toFixed(1)}%〜直近レジスタンス）`,
    },
  }
}

function toStance(score: number): Stance {
  if (score >= 15) return 'bullish'
  if (score <= -15) return 'bearish'
  return 'neutral'
}

const STANCE_LABELS: Record<Stance, string> = {
  bullish: '強気',
  neutral: '中立',
  bearish: '弱気',
}

/** フォールバックインサイト生成 */
export function fallbackInsight(
  ticker: Ticker,
  horizon: Horizon,
  strategy?: StrategyDoc,
  now = Date.now(),
): Insight {
  const sig = analyzeSignals(ticker, horizon)
  const stance = toStance(sig.score)
  const confidence = clamp(Math.round(35 + Math.abs(sig.score) * 0.5), 20, 85)

  const sources = ['テクニカル指標（RSI・モメンタム・出来高）', '7日価格スパークライン']
  if (strategy) sources.push(`戦略「${strategy.name}」`)

  return {
    assetId: ticker.assetId,
    horizon,
    stance,
    confidence,
    summary: `${HORIZON_LABELS[horizon]}スタンスは「${STANCE_LABELS[stance]}」（スコア ${sig.score.toFixed(0)}）。${
      strategy ? `戦略「${strategy.name}」を前提に評価。` : ''
    }`,
    reasons: sig.reasons,
    risks: sig.risks.length > 0 ? sig.risks : ['暗号資産は価格変動が大きく元本割れリスクがあります'],
    entryRanges: computeEntryRanges(ticker),
    sources,
    engine: 'fallback',
    generatedAt: now,
  }
}

/**
 * デモトレードの1ティック判断。
 * 戦略ドキュメントの riskLevel と方向スコアからアクションとサイズを決める。
 */
export function decideTrade(
  ticker: Ticker,
  opts: {
    strategy: StrategyDoc
    /** 当該銘柄の保有評価額 / 総資産 */
    exposureRatio: number
    /** 平均取得単価からの損益率（%）。未保有時は null */
    unrealizedPct: number | null
  },
): TradeDecision {
  const sig = analyzeSignals(ticker, 'short')
  const { strategy, exposureRatio, unrealizedPct } = opts
  const risk = clamp(strategy.riskLevel, 1, 5)
  const maxExposure = 0.08 + risk * 0.06 // riskLevel1: 14% 〜 riskLevel5: 38%

  // 損切り・利確ルール（戦略プリセットの趣旨をロジック化した既定値）
  if (unrealizedPct !== null) {
    if (unrealizedPct <= -8 - risk * 2) {
      return {
        action: 'sell',
        sizeRatio: 1,
        reason: `含み損 ${unrealizedPct.toFixed(1)}% が許容幅を超過したため損切り（戦略「${strategy.name}」）`,
        confidence: 80,
      }
    }
    if (unrealizedPct >= 10 + risk * 4) {
      return {
        action: 'sell',
        sizeRatio: 0.5,
        reason: `含み益 ${unrealizedPct.toFixed(1)}% に到達したため半分利確（戦略「${strategy.name}」）`,
        confidence: 70,
      }
    }
  }

  if (sig.score >= 20 && exposureRatio < maxExposure) {
    const sizeRatio = clamp((maxExposure - exposureRatio) * (sig.score / 100), 0.02, 0.15)
    return {
      action: 'buy',
      sizeRatio,
      reason: `${sig.reasons[0] ?? '上昇シグナル'}。戦略「${strategy.name}」の許容範囲内で買い`,
      confidence: clamp(40 + sig.score / 2, 40, 85),
    }
  }

  if (sig.score <= -20 && exposureRatio > 0) {
    return {
      action: 'sell',
      sizeRatio: 0.5,
      reason: `${sig.reasons[0] ?? '下落シグナル'}。リスク縮小のため一部売却`,
      confidence: clamp(40 - sig.score / 2, 40, 85),
    }
  }

  return {
    action: 'hold',
    sizeRatio: 0,
    reason: `明確なシグナルなし（スコア ${sig.score.toFixed(0)}）。様子見`,
    confidence: 50,
  }
}

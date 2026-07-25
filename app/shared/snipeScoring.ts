import type { LadderRule, SolanaToken } from './types'
import { clamp } from './ta'

/**
 * 新規上場ハンター（スナイプ）モードのトークン選定ロジック。
 * 発行直後のトークンを対象に、公開データから取得できるシグナルで
 * 「候補 / 要注意 / 回避」を判定する:
 *   - SNS の有無（DexScreener token-profiles の links: Website / Twitter / Telegram）
 *   - 初期流動性（少なすぎ=ラグ危険 / 多すぎ=新規上場の妙味なし のスイートスポット評価）
 *   - dev 情報（Solana RPC: mint 権限の放棄・freeze 権限の不在 = ラグ手段の放棄）
 *   - 同一シンボル・同名トークンの再発行チェック（DexScreener 検索の既存ペア照合）
 *   - 初動の買い/売り比率
 * スコアは選定支援であり、投資判断を保証しない（UI に明示）。
 */

export interface FreshTokenSignals {
  hasWebsite: boolean
  hasTwitter: boolean
  hasTelegram: boolean
  /** mint 権限が放棄済みか（null = 未取得） */
  mintAuthorityRenounced: boolean | null
  /** freeze 権限が存在しないか（null = 未取得） */
  freezeAuthorityAbsent: boolean | null
  /** 同一シンボル or 同名の別トークンの既存ペア数（再発行の疑い。null = 未取得） */
  duplicateCount: number | null
  buys24h: number
  sells24h: number
}

export type SnipeVerdict = 'candidate' | 'caution' | 'avoid'

export interface SnipeScore {
  token: SolanaToken
  signals: FreshTokenSignals
  /** 0-100 */
  total: number
  verdict: SnipeVerdict
  reasons: string[]
  warnings: string[]
}

/** スナイプ対象とみなす最大ペア年齢（時間） */
export const SNIPE_MAX_AGE_HOURS = 48

/**
 * 利益確保型ラダー（スナイプ既定）: 早期に元本を回収しつつムーンバッグを残す。
 * 目標配分（初期数量比）: +50% で 30% 利確（初動回収）→ +100% で 30% → +300% で 20% →
 * 残り 20%（ムーンバッグ）は伸ばす。-40% で全損切り。
 *
 * 注意: 取引エンジンの sellRatio は「その時点の残数量」への比率のため、
 * 初期数量比 30/30/20/20 を実現する残数量比は 0.3 → 3/7 → 0.5 になる
 * （検算: 残 0.7 → 0.7×3/7=0.3 決済で残 0.4 → 0.4×0.5=0.2 決済で残 0.2）。
 */
export const SNIPE_LADDER_RULES: LadderRule[] = [
  { triggerPct: 50, sellRatio: 0.3 },
  { triggerPct: 100, sellRatio: 3 / 7 },
  { triggerPct: 300, sellRatio: 0.5 },
  { triggerPct: -40, sellRatio: 1 },
]

/**
 * 同一シンボル・同名の再発行検出。
 * 検索結果のペア群から「別のミントアドレスで、対象より古い、同一シンボル or 同名」を数える。
 * 同じ dev が同名トークンを発行し直すラグ後の再発行パターンの検出に使う。
 */
export function countDuplicates(
  candidates: {
    baseSymbol: string
    baseName: string
    baseAddress: string
    ageHours: number
  }[],
  token: SolanaToken,
): number {
  const symbol = token.baseSymbol.toLowerCase()
  const name = token.baseName.toLowerCase()
  const seen = new Set<string>()
  for (const c of candidates) {
    if (c.baseAddress === token.baseAddress) continue
    if (c.ageHours <= token.ageHours) continue // 対象より新しいものは再発行の根拠にならない
    const sameSymbol = c.baseSymbol.toLowerCase() === symbol
    const sameName = name.length >= 3 && c.baseName.toLowerCase() === name
    if (sameSymbol || sameName) seen.add(c.baseAddress)
  }
  return seen.size
}

export function scoreFreshToken(token: SolanaToken, signals: FreshTokenSignals): SnipeScore {
  const reasons: string[] = []
  const warnings: string[] = []
  let total = 0

  // 初期流動性: $5k〜$150k をスイートスポットとして評価
  const liq = token.liquidityUsd
  if (liq < 2_000) {
    warnings.push('初期流動性が $2k 未満。ラグプルの典型パターン')
  } else if (liq < 5_000) {
    total += 8
    warnings.push('初期流動性が薄い（$5k 未満）')
  } else if (liq <= 150_000) {
    total += 25
    reasons.push(`初期流動性 $${Math.round(liq / 1000)}k（スイートスポット）`)
  } else {
    total += 12
    reasons.push('流動性は厚いが新規上場としての妙味は限定的')
  }

  // SNS の有無
  if (signals.hasWebsite) {
    total += 12
    reasons.push('公式サイトあり')
  }
  if (signals.hasTwitter) {
    total += 12
    reasons.push('X (Twitter) あり')
  }
  if (signals.hasTelegram) {
    total += 6
    reasons.push('Telegram あり')
  }
  if (!signals.hasWebsite && !signals.hasTwitter && !signals.hasTelegram) {
    warnings.push('SNS・サイトが一切ない（コミュニティ不在の可能性）')
  }

  // dev 情報（権限の放棄 = ラグ手段の放棄）
  if (signals.mintAuthorityRenounced === true) {
    total += 18
    reasons.push('mint 権限は放棄済み（増発不可）')
  } else if (signals.mintAuthorityRenounced === false) {
    warnings.push('mint 権限が残存（dev が無限増発可能）')
  }
  if (signals.freezeAuthorityAbsent === true) {
    total += 8
    reasons.push('freeze 権限なし（凍結リスクなし）')
  } else if (signals.freezeAuthorityAbsent === false) {
    warnings.push('freeze 権限が残存（売却を凍結され得る）')
  }

  // 再発行チェック（null = 照合失敗時は加点も減点もしない）
  if (signals.duplicateCount === 0) {
    total += 12
    reasons.push('同名・同シンボルの既存トークンなし')
  } else if (signals.duplicateCount !== null) {
    total -= 15
    warnings.push(
      `同一シンボル/名称の既存トークンが ${signals.duplicateCount} 件（同一 dev の再発行・便乗の疑い）`,
    )
  }

  // 初動の需給（売りゼロは最良の買い優勢として扱う）
  const txns = signals.buys24h + signals.sells24h
  if (txns >= 50 && (signals.sells24h === 0 || signals.buys24h / signals.sells24h >= 1.5)) {
    total += 7
    reasons.push('初動は買い優勢')
  } else if (txns >= 50 && signals.buys24h > 0 && signals.sells24h / signals.buys24h >= 2) {
    warnings.push('売り優勢（初動の投げが強い）')
  }

  if (token.ageHours < 1) {
    warnings.push('発行から 1 時間未満の超初期（値動きが極端になりやすい）')
  }

  total = clamp(total, 0, 100)
  const verdict: SnipeVerdict =
    warnings.some((w) => w.includes('ラグプル')) || (signals.duplicateCount ?? 0) >= 2
      ? 'avoid'
      : total >= 60
        ? 'candidate'
        : total >= 40
          ? 'caution'
          : 'avoid'

  return { token, signals, total, verdict, reasons, warnings }
}

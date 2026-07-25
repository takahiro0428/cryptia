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

/** 判定の表示定義（ラベル + バッジ CSS クラス）。カード・詳細パネルで共通利用 */
export const SNIPE_VERDICT_LABELS: Record<SnipeVerdict, { label: string; cls: string }> = {
  candidate: { label: '候補', cls: 'badge-up' },
  caution: { label: '要注意', cls: 'badge-warn' },
  avoid: { label: '回避', cls: 'badge-down' },
}

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

/** ローリング監視プールの保持上限（発見の蓄積。表示はおすすめ上位のみ） */
export const FRESH_POOL_MAX = 50
/** 画面に表示するおすすめ上位件数 */
export const FRESH_DISPLAY_MAX = 10

export interface FreshPoolEntry {
  score: SnipeScore
  /** 発見フィードで最後に確認した時刻（プールの経時失効判定に使用） */
  lastSeenAt: number
}

/**
 * ローリング監視プールのマージ（固定スナップショットではなく蓄積型の監視）。
 * - 重複排除は**ミント（baseAddress）単位**。新規トークンは 48h 窓内に代表プールが
 *   移り変わる（pump.fun → Raydium 移行等）ため、pairAddress キーだと同一トークンが
 *   複数枠を占有し、自動スナイプの二重エントリー経路になる
 * - 新規発見はプールへ追加、既知トークンは最新の情報・スコアへ置換する
 * - フィードから外れたトークンも 48h 窓の間は監視を継続する
 *   （経過時間 = 最終確認時点の年齢 + 最終確認からの経過で失効判定）
 * - おすすめ順（判定 → スコア）で上限件数まで保持する。ただし今サイクルの新規発見は
 *   優先残留させる（プール満杯で新着が一度も監査されず即追い出されるのを防ぐ）
 */
export function mergeFreshPool(
  existing: FreshPoolEntry[],
  incoming: SnipeScore[],
  now: number,
  maxAgeHours = SNIPE_MAX_AGE_HOURS,
  cap = FRESH_POOL_MAX,
): FreshPoolEntry[] {
  const byMint = new Map(existing.map((e) => [e.score.token.baseAddress, e]))
  const incomingMints = new Set<string>()
  for (const score of incoming) {
    byMint.set(score.token.baseAddress, { score, lastSeenAt: now })
    incomingMints.add(score.token.baseAddress)
  }
  const rank: Record<SnipeVerdict, number> = { candidate: 0, caution: 1, avoid: 2 }
  const recommend = (a: FreshPoolEntry, b: FreshPoolEntry) =>
    rank[a.score.verdict] - rank[b.score.verdict] || b.score.total - a.score.total
  const alive = [...byMint.values()]
    .filter((e) => e.score.token.ageHours + (now - e.lastSeenAt) / 3_600_000 <= maxAgeHours)
    .sort(recommend)
  if (alive.length <= cap) return alive
  // 今サイクル確認分を優先残留させたうえで、残枠をおすすめ順に埋める
  const freshFirst = [
    ...alive.filter((e) => incomingMints.has(e.score.token.baseAddress)),
    ...alive.filter((e) => !incomingMints.has(e.score.token.baseAddress)),
  ]
  return freshFirst.slice(0, cap).sort(recommend)
}

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

/** 自動スナイプ監査: エントリーを許可する最低流動性 */
export const AUTO_SNIPE_MIN_LIQUIDITY_USD = 5_000

/**
 * 自動スナイプ（常時監視）の最低限監査 = エントリーゲート。
 * スコアリングの総合判定に加え、「危険と判明している」シグナルを個別に拒否する。
 * null（未取得）は拒否しない — 取得できないことと危険であることは区別する
 * （厳格にしすぎると照合系 API の一時障害で全エントリーが止まるため）。
 */
export function passesMinimalAudit(
  score: SnipeScore,
  opts: { allowCaution?: boolean } = {},
): boolean {
  const verdictOk = opts.allowCaution
    ? score.verdict !== 'avoid'
    : score.verdict === 'candidate'
  return (
    verdictOk &&
    score.token.liquidityUsd >= AUTO_SNIPE_MIN_LIQUIDITY_USD &&
    // mint 権限の残存が判明 = dev が無限増発可能 → 拒否
    score.signals.mintAuthorityRenounced !== false &&
    // freeze 権限の残存が判明 = 売却を凍結され得る → 拒否
    score.signals.freezeAuthorityAbsent !== false &&
    // 同名再発行 2 件以上 = ラグ後の再発行パターン → 拒否
    (score.signals.duplicateCount ?? 0) < 2
  )
}

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

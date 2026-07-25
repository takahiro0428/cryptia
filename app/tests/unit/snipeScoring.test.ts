import { describe, expect, it } from 'vitest'
import {
  buildMoonbagLadder,
  countDuplicates,
  mergeFreshPool,
  MOONBAG_DEFAULT_STOP_LOSS_PCT,
  normalizeMoonbagStopLoss,
  passesMinimalAudit,
  scoreFreshToken,
  SNIPE_LADDER_RULES,
  type FreshPoolEntry,
  type FreshTokenSignals,
} from '~/shared/snipeScoring'
import { checkLadder } from '~/shared/tradeEngine'
import type { SolanaToken } from '~/shared/types'

function token(overrides: Partial<SolanaToken> = {}): SolanaToken {
  return {
    pairAddress: 'PAIRxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1',
    baseSymbol: 'FRESH',
    baseName: 'Fresh Token',
    baseAddress: 'MINTxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx1',
    priceUsd: 0.001,
    liquidityUsd: 30_000,
    volume24hUsd: 100_000,
    change24hPct: 20,
    ageHours: 6,
    txns24h: 500,
    ...overrides,
  }
}

function signals(overrides: Partial<FreshTokenSignals> = {}): FreshTokenSignals {
  return {
    hasWebsite: true,
    hasTwitter: true,
    hasTelegram: true,
    mintAuthorityRenounced: true,
    freezeAuthorityAbsent: true,
    duplicateCount: 0,
    buys24h: 300,
    sells24h: 100,
    ...overrides,
  }
}

describe('snipeScoring: スコアリングと判定', () => {
  it('好条件（SNS完備・権限放棄・再発行なし・適正流動性）は候補判定', () => {
    const score = scoreFreshToken(token(), signals())
    expect(score.verdict).toBe('candidate')
    expect(score.total).toBeGreaterThanOrEqual(60)
    expect(score.reasons.length).toBeGreaterThan(0)
  })

  it('流動性 $2k 未満はラグプル警告つきで回避判定', () => {
    const score = scoreFreshToken(token({ liquidityUsd: 1_000 }), signals())
    expect(score.verdict).toBe('avoid')
    expect(score.warnings.some((w) => w.includes('ラグプル'))).toBe(true)
  })

  it('再発行 2 件以上は総合点に関わらず回避判定', () => {
    const score = scoreFreshToken(token(), signals({ duplicateCount: 2 }))
    expect(score.verdict).toBe('avoid')
    expect(score.warnings.some((w) => w.includes('再発行'))).toBe(true)
  })

  it('mint 権限が残存している場合は警告が付く', () => {
    const score = scoreFreshToken(token(), signals({ mintAuthorityRenounced: false }))
    expect(score.warnings.some((w) => w.includes('mint'))).toBe(true)
  })

  it('SNS が一切ない場合は警告が付き加点されない', () => {
    const withSns = scoreFreshToken(token(), signals())
    const noSns = scoreFreshToken(
      token(),
      signals({ hasWebsite: false, hasTwitter: false, hasTelegram: false }),
    )
    expect(noSns.total).toBeLessThan(withSns.total)
    expect(noSns.warnings.some((w) => w.includes('SNS'))).toBe(true)
  })

  it('未取得シグナル（null）は加点も減点もしない', () => {
    const known = scoreFreshToken(token(), signals({ duplicateCount: 0 }))
    const unknown = scoreFreshToken(
      token(),
      signals({ duplicateCount: null, mintAuthorityRenounced: null, freezeAuthorityAbsent: null }),
    )
    // 各ボーナス（+12, +18, +8）分だけ低くなるが、減点はされない
    expect(unknown.total).toBe(known.total - 12 - 18 - 8)
    // null による「回避」判定の誤爆はしない
    expect(unknown.verdict).not.toBe('avoid')
  })

  it('スコアは 0-100 に収まる', () => {
    const low = scoreFreshToken(
      token({ liquidityUsd: 1_000 }),
      signals({
        hasWebsite: false,
        hasTwitter: false,
        hasTelegram: false,
        mintAuthorityRenounced: false,
        freezeAuthorityAbsent: false,
        duplicateCount: 5,
        buys24h: 10,
        sells24h: 100,
      }),
    )
    expect(low.total).toBeGreaterThanOrEqual(0)
    expect(low.total).toBeLessThanOrEqual(100)
  })
})

describe('snipeScoring: 再発行検出', () => {
  const target = token({ ageHours: 3 })

  it('同一シンボルで対象より古い別アドレスのみ数える', () => {
    const candidates = [
      // 対象自身 → 数えない
      { baseSymbol: 'FRESH', baseName: 'Fresh Token', baseAddress: target.baseAddress, ageHours: 3 },
      // 古い同一シンボル → 数える
      { baseSymbol: 'FRESH', baseName: 'Other', baseAddress: 'MINTold1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ageHours: 100 },
      // 対象より新しい → 数えない（再発行の根拠にならない）
      { baseSymbol: 'FRESH', baseName: 'Newer', baseAddress: 'MINTnew1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ageHours: 1 },
      // 同名（大文字小文字違い）で古い → 数える
      { baseSymbol: 'OTHER', baseName: 'fresh token', baseAddress: 'MINTold2xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ageHours: 200 },
    ]
    expect(countDuplicates(candidates, target)).toBe(2)
  })

  it('同一アドレスの重複ペアは 1 件として数える', () => {
    const candidates = [
      { baseSymbol: 'FRESH', baseName: 'A', baseAddress: 'MINTdup1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ageHours: 50 },
      { baseSymbol: 'FRESH', baseName: 'B', baseAddress: 'MINTdup1xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ageHours: 60 },
    ]
    expect(countDuplicates(candidates, target)).toBe(1)
  })

  it('短すぎる名前（3文字未満）は名前一致でカウントしない', () => {
    const short = token({ baseName: 'AB', baseSymbol: 'ABQ', ageHours: 3 })
    const candidates = [
      { baseSymbol: 'ZZZ', baseName: 'ab', baseAddress: 'MINTshortxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx', ageHours: 100 },
    ]
    expect(countDuplicates(candidates, short)).toBe(0)
  })
})

describe('snipeScoring: 自動スナイプの最低限監査', () => {
  it('候補判定 + 全シグナル良好は通過する', () => {
    expect(passesMinimalAudit(scoreFreshToken(token(), signals()))).toBe(true)
  })

  it('要注意判定は既定で不通過、allowCaution で通過する', () => {
    // サイトのみ・権限未取得 → スコア 40 台の「要注意」帯
    const caution = scoreFreshToken(
      token(),
      signals({
        hasTwitter: false,
        hasTelegram: false,
        mintAuthorityRenounced: null,
        freezeAuthorityAbsent: null,
        duplicateCount: 0,
        buys24h: 10,
        sells24h: 10,
      }),
    )
    expect(caution.verdict).toBe('caution')
    expect(passesMinimalAudit(caution)).toBe(false)
    expect(passesMinimalAudit(caution, { allowCaution: true })).toBe(true)
  })

  it('mint 権限の残存が判明している場合は候補判定でも不通過', () => {
    const score = scoreFreshToken(token(), signals({ mintAuthorityRenounced: false }))
    expect(score.verdict).toBe('candidate') // 総合点では候補に届く
    expect(passesMinimalAudit(score)).toBe(false)
  })

  it('freeze 権限の残存が判明している場合は不通過', () => {
    const score = scoreFreshToken(token(), signals({ freezeAuthorityAbsent: false }))
    expect(passesMinimalAudit(score)).toBe(false)
  })

  it('流動性 $5k 未満は不通過', () => {
    const score = scoreFreshToken(token({ liquidityUsd: 4_000 }), signals())
    expect(passesMinimalAudit(score, { allowCaution: true })).toBe(false)
  })

  it('回避判定は allowCaution でも不通過', () => {
    const score = scoreFreshToken(token(), signals({ duplicateCount: 3 }))
    expect(score.verdict).toBe('avoid')
    expect(passesMinimalAudit(score, { allowCaution: true })).toBe(false)
  })

  it('未取得（null）シグナルは拒否理由にしない', () => {
    const score = scoreFreshToken(
      token(),
      signals({ mintAuthorityRenounced: null, freezeAuthorityAbsent: null, duplicateCount: null }),
    )
    expect(score.verdict).toBe('candidate')
    expect(passesMinimalAudit(score)).toBe(true)
  })
})

describe('snipeScoring: ローリング監視プール', () => {
  const HOUR = 3_600_000
  const t0 = 1_000_000_000_000

  function entry(addr: string, ageHours: number, lastSeenAt: number, total = 80): FreshPoolEntry {
    const score = scoreFreshToken(
      token({ pairAddress: addr, baseAddress: `MINT${addr}`, ageHours }),
      signals(),
    )
    return { score: { ...score, total }, lastSeenAt }
  }

  it('新規発見はプールへ追加され、既知トークンは最新情報へ置換される', () => {
    const existing = [entry('PAIRold', 10, t0 - HOUR)]
    const updated = scoreFreshToken(
      token({ pairAddress: 'PAIRold', baseAddress: 'MINTPAIRold', ageHours: 11, priceUsd: 0.005 }),
      signals(),
    )
    const fresh = scoreFreshToken(
      token({ pairAddress: 'PAIRnew', baseAddress: 'MINTPAIRnew', ageHours: 1 }),
      signals(),
    )
    const pool = mergeFreshPool(existing, [updated, fresh], t0)
    expect(pool).toHaveLength(2)
    const old = pool.find((e) => e.score.token.pairAddress === 'PAIRold')!
    expect(old.score.token.priceUsd).toBe(0.005) // 最新情報へ置換
    expect(old.lastSeenAt).toBe(t0)
  })

  it('フィードから外れても 48h 窓の間は監視を継続し、超過で失効する', () => {
    // 最終確認時 40h → 未再確認のまま 6h 経過 = 実効 46h（継続）
    const alive = entry('PAIRalive', 40, t0 - 6 * HOUR)
    // 最終確認時 40h → 未再確認のまま 10h 経過 = 実効 50h（失効）
    const expired = entry('PAIRexpired', 40, t0 - 10 * HOUR)
    const pool = mergeFreshPool([alive, expired], [], t0)
    expect(pool.map((e) => e.score.token.pairAddress)).toEqual(['PAIRalive'])
  })

  it('おすすめ順（判定 → スコア）で上限件数まで保持する', () => {
    const entries = Array.from({ length: 60 }, (_, i) => entry(`PAIR${i}`, 5, t0, i))
    const pool = mergeFreshPool(entries, [], t0, 48, 50)
    expect(pool).toHaveLength(50)
    // スコア降順（低スコアの 10 件が間引かれる）
    expect(pool[0].score.total).toBe(59)
    expect(pool[49].score.total).toBe(10)
  })

  it('重複排除はミント単位（代表プールが移り変わっても同一トークンは1枠）', () => {
    const oldPool = scoreFreshToken(
      token({ pairAddress: 'PAIRpumpfun', baseAddress: 'MINTsame', ageHours: 5, priceUsd: 0.001 }),
      signals(),
    )
    const newPool = scoreFreshToken(
      token({ pairAddress: 'PAIRraydium', baseAddress: 'MINTsame', ageHours: 6, priceUsd: 0.002 }),
      signals(),
    )
    const pool = mergeFreshPool([{ score: oldPool, lastSeenAt: t0 - HOUR }], [newPool], t0)
    expect(pool).toHaveLength(1)
    expect(pool[0].score.token.pairAddress).toBe('PAIRraydium') // 最新の代表ペアを採用
  })

  it('プール満杯時も今サイクルの新規発見は優先残留する（新着の即追い出し防止）', () => {
    // 高スコアの既存 50 件で満杯
    const existing = Array.from({ length: 50 }, (_, i) => entry(`PAIRex${i}`, 5, t0 - HOUR, 90))
    // 低スコア（caution 相当）の新規発見
    const newcomerScore = scoreFreshToken(
      token({ pairAddress: 'PAIRnewcomer', baseAddress: 'MINTnewcomer', ageHours: 0.5 }),
      signals({
        hasTwitter: false,
        hasTelegram: false,
        mintAuthorityRenounced: null,
        freezeAuthorityAbsent: null,
        buys24h: 10,
        sells24h: 10,
      }),
    )
    const pool = mergeFreshPool(existing, [newcomerScore], t0, 48, 50)
    expect(pool).toHaveLength(50)
    expect(pool.some((e) => e.score.token.pairAddress === 'PAIRnewcomer')).toBe(true)
  })
})

describe('snipeScoring: スナイプラダー（利益確保型）', () => {
  it('+50% で第一段の利確が発動する（早期の元本回収）', () => {
    const fired = checkLadder(1.0, 1.5, SNIPE_LADDER_RULES, [])
    expect(fired.some((f) => f.rule.triggerPct === 50)).toBe(true)
  })

  it('全利確段の累積配分が初期数量比 30/30/20 + ムーンバッグ 20% になる', () => {
    // エンジンの sellRatio は残数量比のため、順次適用して初期数量比を検算する
    let remaining = 1
    const soldFractions: number[] = []
    for (const rule of SNIPE_LADDER_RULES.filter((r) => r.triggerPct > 0)) {
      const sold = remaining * rule.sellRatio
      soldFractions.push(sold)
      remaining -= sold
    }
    expect(soldFractions[0]).toBeCloseTo(0.3, 10)
    expect(soldFractions[1]).toBeCloseTo(0.3, 10)
    expect(soldFractions[2]).toBeCloseTo(0.2, 10)
    expect(remaining).toBeCloseTo(0.2, 10)
  })

  it('売りゼロ・買い多数は最良の買い優勢として加点される', () => {
    const zeroSells = scoreFreshToken(token(), signals({ buys24h: 300, sells24h: 0 }))
    const someSells = scoreFreshToken(token(), signals({ buys24h: 300, sells24h: 1 }))
    expect(zeroSells.reasons).toContain('初動は買い優勢')
    expect(zeroSells.total).toBeGreaterThanOrEqual(someSells.total)
  })

  it('+100% では +50% と +100% の両段が発動対象になる', () => {
    const fired = checkLadder(1.0, 2.0, SNIPE_LADDER_RULES, [])
    const pcts = fired.map((f) => f.rule.triggerPct)
    expect(pcts).toContain(50)
    expect(pcts).toContain(100)
  })

  it('-40% で全損切りが発動する', () => {
    const fired = checkLadder(1.0, 0.55, SNIPE_LADDER_RULES, [])
    const stop = fired.find((f) => f.rule.triggerPct === -40)
    expect(stop).toBeDefined()
    expect(stop!.rule.sellRatio).toBe(1)
  })

  it('発動済みの段は再発動しない（冪等性）', () => {
    const first = checkLadder(1.0, 1.6, SNIPE_LADDER_RULES, [])
    const triggered = first.map((f) => f.index)
    expect(checkLadder(1.0, 1.6, SNIPE_LADDER_RULES, triggered)).toHaveLength(0)
  })
})

describe('snipeScoring: ムーンバッグラダー', () => {
  it('損切りありは [利確 +100%/70%, 損切り/全量] の 2 段で構築される', () => {
    expect(buildMoonbagLadder(-50)).toEqual([
      { triggerPct: 100, sellRatio: 0.7 },
      { triggerPct: -50, sellRatio: 1 },
    ])
  })

  it('損切りなし（null）は利確 1 段のみ（下落側の出口を持たない = 完全放置）', () => {
    const rules = buildMoonbagLadder(null)
    expect(rules).toEqual([{ triggerPct: 100, sellRatio: 0.7 }])
    // -90% でも発動するルールがない
    expect(checkLadder(1.0, 0.1, rules, [])).toHaveLength(0)
  })

  it('+100% で 70% 売却 = 元本の 1.4 倍回収（元本+40% 確定）', () => {
    const rules = buildMoonbagLadder(-50)
    const fired = checkLadder(1.0, 2.0, rules, [])
    expect(fired).toHaveLength(1)
    expect(fired[0].rule.sellRatio).toBe(0.7)
    // 検算: 売却額 = 0.7 × 2.0 = 1.4（対エントリー時投入額）
    expect((1 + fired[0].rule.triggerPct / 100) * fired[0].rule.sellRatio).toBeCloseTo(1.4, 10)
  })

  it('利確と損切りは同一価格で同時発動しない（相互排他）', () => {
    const rules = buildMoonbagLadder(-50)
    for (const price of [0.4, 0.5, 1.0, 1.99, 2.0, 3.0]) {
      expect(checkLadder(1.0, price, rules, []).length).toBeLessThanOrEqual(1)
    }
  })

  it('normalizeMoonbagStopLoss: null は明示選択として保持、不正値は既定へ、範囲はクランプ', () => {
    expect(normalizeMoonbagStopLoss(null)).toBeNull()
    expect(normalizeMoonbagStopLoss(undefined)).toBe(MOONBAG_DEFAULT_STOP_LOSS_PCT)
    expect(normalizeMoonbagStopLoss(Number.NaN)).toBe(MOONBAG_DEFAULT_STOP_LOSS_PCT)
    expect(normalizeMoonbagStopLoss(30)).toBe(MOONBAG_DEFAULT_STOP_LOSS_PCT) // 正値は不正
    expect(normalizeMoonbagStopLoss(-500)).toBe(-90)
    expect(normalizeMoonbagStopLoss(-5)).toBe(-10)
    expect(normalizeMoonbagStopLoss(-30)).toBe(-30)
  })
})

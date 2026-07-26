import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  buildScalpLadder,
  effectiveAgeMinutes,
  normalizeScalpMaxAge,
  normalizeScalpMaxHold,
  normalizeScalpStop,
  normalizeScalpTarget,
  scoreFreshToken,
  type FreshTokenSignals,
  type SnipeScore,
} from '~/shared/snipeScoring'
import { checkLadder, createPortfolio, positionOf } from '~/shared/tradeEngine'
import type { SolanaToken } from '~/shared/types'
import {
  DEFAULT_AUTO_SNIPE,
  normalizeScalpConfig,
  useSolanaStore,
  type DegenSession,
} from '~/stores/solana'

/**
 * スキャルプモード（発行直後買い・早期全量利確・高速回転）の結合テスト。
 * 年齢ゲート・全量利確・損切り・時間切れ手仕舞い・枠の回転を検証する。
 */

let seq = 0
function freshScore(tokenOverrides: Partial<SolanaToken> = {}): SnipeScore {
  seq++
  const B58 = 'abcdefghijkmnopqrstuvwxyz'
  const tag = B58[seq % 25]! + B58[Math.floor(seq / 25) % 25]!
  const token: SolanaToken = {
    pairAddress: `Spair${tag}${'1'.repeat(37)}`.slice(0, 44),
    baseSymbol: `SCLP${seq}`,
    baseName: `Scalp Token ${seq}`,
    baseAddress: `Smint${tag}${'2'.repeat(37)}`.slice(0, 44),
    priceUsd: 0.001,
    liquidityUsd: 30_000,
    volume24hUsd: 100_000,
    change24hPct: 20,
    ageHours: 0.05, // 3 分
    ageKnown: true,
    txns24h: 500,
    ...tokenOverrides,
  }
  const signals: FreshTokenSignals = {
    hasWebsite: true,
    hasTwitter: true,
    hasTelegram: true,
    mintAuthorityRenounced: true,
    freezeAuthorityAbsent: true,
    duplicateCount: 0,
    buys24h: 300,
    sells24h: 100,
  }
  return scoreFreshToken(token, signals)
}

function makeScalpSession(maxPositions = 2): DegenSession {
  const scalp = normalizeScalpConfig({})
  return {
    id: `test-scalp-${++seq}`,
    name: 'スキャルプテスト',
    createdAt: Date.now(),
    portfolio: createPortfolio(1_000),
    running: true,
    method: 'scalp',
    ladderRules: buildScalpLadder(scalp.targetPct, scalp.stopPct),
    watchedPairs: [],
    positionMeta: {},
    autoSnipe: { ...DEFAULT_AUTO_SNIPE, maxPositions, allowCaution: true },
    enteredPairs: [],
    enteredMints: [],
    scalp,
  }
}

function setupStore(scores: SnipeScore[], session: DegenSession) {
  const store = useSolanaStore()
  store.sessions = [session]
  store.usingMockData = false
  store.freshFetchedAt = Date.now()
  store.freshTokens = scores
  store.freshSeenAt = Object.fromEntries(scores.map((s) => [s.token.pairAddress, Date.now()]))
  return store
}

function setPrice(store: ReturnType<typeof useSolanaStore>, score: SnipeScore, priceUsd: number) {
  const token = { ...score.token, priceUsd }
  const i = store.tokens.findIndex((t) => t.pairAddress === token.pairAddress)
  if (i >= 0) store.tokens[i] = token
  else store.tokens.push(token)
}

describe('snipeScoring: スキャルプの正規化・ラダー・年齢計算', () => {
  it('buildScalpLadder は [利確全量, 損切り全量] の 2 段', () => {
    expect(buildScalpLadder(50, -30)).toEqual([
      { triggerPct: 50, sellRatio: 1 },
      { triggerPct: -30, sellRatio: 1 },
    ])
    // +50% で利確段のみ発火・全量
    const fired = checkLadder(1.0, 1.5, buildScalpLadder(50, -30), [])
    expect(fired).toHaveLength(1)
    expect(fired[0].rule.sellRatio).toBe(1)
  })

  it('正規化はクランプ + 不正値は既定へ', () => {
    expect(normalizeScalpTarget(70)).toBe(70)
    expect(normalizeScalpTarget(1000)).toBe(200)
    expect(normalizeScalpTarget(Number.NaN)).toBe(50)
    expect(normalizeScalpStop(-30)).toBe(-30)
    expect(normalizeScalpStop(30)).toBe(-30)
    expect(normalizeScalpMaxAge(0)).toBe(5)
    expect(normalizeScalpMaxAge(99)).toBe(30)
    expect(normalizeScalpMaxHold(15)).toBe(15)
    expect(normalizeScalpMaxHold(-1)).toBe(15)
  })

  it('effectiveAgeMinutes = 確認時の年齢 + 確認からの経過', () => {
    const now = Date.now()
    expect(effectiveAgeMinutes(0.05, now, now)).toBeCloseTo(3, 5)
    expect(effectiveAgeMinutes(0.05, now - 4 * 60_000, now)).toBeCloseTo(7, 5)
  })
})

describe('スキャルプモード: 発行直後買い → 早期全量利確の高速回転', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  it('年齢ゲート: 実効経過が上限（5 分）以内のトークンにのみエントリーする', async () => {
    const young = freshScore({ ageHours: 0.05 }) // 3 分
    const old = freshScore({ ageHours: 0.5 }) // 30 分
    const store = setupStore([young, old], makeScalpSession(3))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    const current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, young.token.pairAddress)).toBeTruthy()
    expect(positionOf(current.portfolio, old.token.pairAddress)).toBeUndefined()
    expect(current.positionMeta[young.token.pairAddress].enteredAt).toBeDefined()
    expect(current.portfolio.orders[0].strategy).toBe('スキャルプ')
  })

  it('利確ターゲット +50% 到達で全量売却し、枠が空いて次の銘柄へ回転する', async () => {
    const first = freshScore({ priceUsd: 0.001 })
    const store = setupStore([first], makeScalpSession(1))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []
    setPrice(store, first, 0.0015) // +50%
    await store._processSession(session.id)

    let current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, first.token.pairAddress)).toBeUndefined() // 全量売却
    const sell = current.portfolio.orders.find((o) => o.side === 'sell')!
    expect(sell.reason).toContain('スキャルプ利確')
    // 枠が空いたので次の新しい銘柄へエントリーできる（回転）
    const second = freshScore({ priceUsd: 0.001 })
    store.freshTokens = [second]
    store.freshFetchedAt = Date.now()
    store.freshSeenAt = { [second.token.pairAddress]: Date.now() }
    await store._autoSnipeEntries(session.id)
    current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, second.token.pairAddress)).toBeTruthy()
    // 同一ミントへの再エントリーは引き続き禁止
    expect(current.enteredMints).toContain(first.token.baseAddress)
  })

  it('損切りライン -30% 到達で全量売却する', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeScalpSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []
    setPrice(store, good, 0.0006) // -40%
    await store._processSession(session.id)
    const current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, good.token.pairAddress)).toBeUndefined()
    expect(current.portfolio.orders.find((o) => o.side === 'sell')!.reason).toContain('損切り')
  })

  it('時間切れ: 上限（15 分）を超えても利確/損切りに届かない銘柄は全量手仕舞いする', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeScalpSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []
    // エントリーから 16 分経過・価格は +10%（どのラインにも届かない）を再現
    const meta = store.sessions[0].positionMeta[good.token.pairAddress]
    meta.enteredAt = Date.now() - 16 * 60_000
    setPrice(store, good, 0.0011)
    await store._processSession(session.id)
    const current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, good.token.pairAddress)).toBeUndefined()
    const sell = current.portfolio.orders.find((o) => o.side === 'sell')!
    expect(sell.reason).toContain('時間切れ')
  })

  it('年齢ゲート境界: ちょうど上限は通過・超過と発行時刻不明は除外', async () => {
    // 境界（ちょうど 5 分 = 通過）は実時間の経過で ε 超過し得るため、時刻を凍結して決定論化する
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      const atLimit = freshScore({ ageHours: 5 / 60 }) // ちょうど 5 分
      const over = freshScore({ ageHours: 5.5 / 60 })
      const unknown = freshScore({ ageHours: 0, ageKnown: false }) // 発行時刻不明
      const store = setupStore([atLimit, over, unknown], makeScalpSession(3))
      const session = store.sessions[0]
      await store._autoSnipeEntries(session.id)
      const current = store.sessionById(session.id)!
      expect(positionOf(current.portfolio, atLimit.token.pairAddress)).toBeTruthy()
      expect(positionOf(current.portfolio, over.token.pairAddress)).toBeUndefined()
      expect(positionOf(current.portfolio, unknown.token.pairAddress)).toBeUndefined()
    } finally {
      vi.useRealTimers()
    }
  })

  it('価格喪失（ラグでフィードから消えた銘柄）でも時間切れは執行され、枠が回転する', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeScalpSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []
    store.tokens = [] // 価格フィード喪失を再現（tokenOf が解決できない）
    const meta = store.sessions[0].positionMeta[good.token.pairAddress]
    meta.enteredAt = Date.now() - 16 * 60_000
    await store._processSession(session.id)
    const current = store.sessionById(session.id)!
    // 評価 $0 の帳簿決済としてポジションが除去され、枠が固定化しない（ISSUE-P9-M24/L42）
    expect(positionOf(current.portfolio, good.token.pairAddress)).toBeUndefined()
  })

  it('enteredAt が未設定の旧ポジションは時間切れ判定をスキップする（後方互換）', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeScalpSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []
    const meta = store.sessions[0].positionMeta[good.token.pairAddress]
    meta.enteredAt = undefined // 旧データ相当
    setPrice(store, good, 0.0011)
    await store._processSession(session.id)
    expect(positionOf(store.sessionById(session.id)!.portfolio, good.token.pairAddress)).toBeTruthy()
  })

  it('復元時は scalp 設定を正規化し、ラダーを設定から再構築する（設定が SoT）', async () => {
    const { saveLocal } = await import('~/composables/usePersistence')
    const corrupt = makeScalpSession(2)
    corrupt.running = false
    corrupt.scalp = { targetPct: 9999, stopPct: 5, maxAgeMin: -3, maxHoldMin: 0 } as never
    corrupt.ladderRules = []
    saveLocal('solana-degen', { sessions: [corrupt], archives: [] })
    const store = useSolanaStore()
    await store.restoreState()
    const restored = store.sessions[0]
    expect(restored.scalp).toEqual({ targetPct: 200, stopPct: -30, maxAgeMin: 5, maxHoldMin: 15 })
    expect(restored.ladderRules).toEqual(buildScalpLadder(200, -30))
  })
})

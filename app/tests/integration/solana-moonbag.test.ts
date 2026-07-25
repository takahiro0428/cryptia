import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { saveLocal } from '~/composables/usePersistence'
import {
  buildMoonbagLadder,
  MOONBAG_DEFAULT_STOP_LOSS_PCT,
  scoreFreshToken,
  type FreshTokenSignals,
  type SnipeScore,
} from '~/shared/snipeScoring'
import { createPortfolio, positionOf } from '~/shared/tradeEngine'
import type { SolanaToken } from '~/shared/types'
import { DEFAULT_AUTO_SNIPE, useSolanaStore, type DegenSession } from '~/stores/solana'

/**
 * ムーンバッグモードの結合テスト（F-06 拡張）。
 * エントリーは自動スナイプと同一パイプライン（別テストで検証済み）のため、
 * ここでは moonbag 固有の挙動を検証する:
 *   - +100% 到達で 70% 売却 → ムーンバッグ化（全ルール無効化・恒久保持）
 *   - ムーンバッグ化後は損切りラインを割っても売却しない
 *   - ムーンバッグは同時ポジション数に数えない（新規エントリー枠を塞がない）
 *   - +100% 未到達での損切り（設定あり）と、損切りなし（完全放置）の両動作
 *   - 復元時の設定正規化（moonbagStopLossPct がルール構成の SoT）
 */

let seq = 0
function freshScore(
  tokenOverrides: Partial<SolanaToken> = {},
  signalOverrides: Partial<FreshTokenSignals> = {},
): SnipeScore {
  seq++
  const token: SolanaToken = {
    pairAddress: `PAIRmoon${seq}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44),
    baseSymbol: `MB${seq}`,
    baseName: `Moonbag Token ${seq}`,
    baseAddress: `MINTmoon${seq}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44),
    priceUsd: 0.001,
    liquidityUsd: 30_000,
    volume24hUsd: 100_000,
    change24hPct: 20,
    ageHours: 3,
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
    ...signalOverrides,
  }
  return scoreFreshToken(token, signals)
}

function makeMoonbagSession(
  maxPositions = 2,
  stopLossPct: number | null = MOONBAG_DEFAULT_STOP_LOSS_PCT,
): DegenSession {
  return {
    id: `test-moonbag-${++seq}`,
    name: 'ムーンバッグテスト',
    createdAt: Date.now(),
    portfolio: createPortfolio(1_000),
    running: true,
    method: 'moonbag',
    ladderRules: buildMoonbagLadder(stopLossPct),
    watchedPairs: [],
    positionMeta: {},
    autoSnipe: { ...DEFAULT_AUTO_SNIPE, maxPositions },
    enteredPairs: [],
    enteredMints: [],
    moonbagStopLossPct: stopLossPct,
  }
}

function setupStore(scores: SnipeScore[], session: DegenSession) {
  const store = useSolanaStore()
  store.sessions = [session]
  store.usingMockData = false
  store.freshFetchedAt = Date.now() // TTL 内 → fetchFreshTokens は即 return し投入データを維持
  store.freshTokens = scores
  store.freshSeenAt = Object.fromEntries(scores.map((s) => [s.token.pairAddress, Date.now()]))
  return store
}

/** 監視中トークンの現在価格を差し替える（tokenOf が tokens を優先参照する） */
function setPrice(store: ReturnType<typeof useSolanaStore>, score: SnipeScore, priceUsd: number) {
  const token = { ...score.token, priceUsd }
  const i = store.tokens.findIndex((t) => t.pairAddress === token.pairAddress)
  if (i >= 0) store.tokens[i] = token
  else store.tokens.push(token)
}

describe('ムーンバッグモード: +100% で 70% 売却 → 残り恒久保持', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  it('エントリーは自動スナイプと同じ監査パイプライン（戦略名・理由はムーンバッグ表記）', async () => {
    const good = freshScore()
    const store = setupStore([good], makeMoonbagSession(2))
    const session = store.sessions[0]

    await store._autoSnipeEntries(session.id)

    const current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(1)
    expect(current.portfolio.orders[0].strategy).toBe('ムーンバッグ')
    expect(current.portfolio.orders[0].reason).toContain('ムーンバッグ戦略')
    expect(current.portfolio.orders[0].reason).toContain('監査通過')
  })

  it('+100% 到達で 70% を売却し、ムーンバッグ化する（元本の 1.4 倍を確定回収）', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeMoonbagSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    const qtyBefore = positionOf(store.sessionById(session.id)!.portfolio, good.token.pairAddress)!.quantity

    // 監視プールを空にして以後の新規エントリーを止め、価格 2 倍でティック処理
    store.freshTokens = []
    setPrice(store, good, 0.002)
    await store._processSession(session.id)

    const current = store.sessionById(session.id)!
    const pos = positionOf(current.portfolio, good.token.pairAddress)!
    const sell = current.portfolio.orders.find((o) => o.side === 'sell')!
    // 70% 売却・30% 保持
    expect(sell.quantity).toBeCloseTo(qtyBefore * 0.7, 6)
    expect(pos.quantity).toBeCloseTo(qtyBefore * 0.3, 6)
    expect(sell.reason).toContain('ムーンバッグ利確')
    expect(sell.reason).toContain('元本+40%')
    // 売却代金 = 数量 70% × 価格 2 倍 = 投入額（$500）の 1.4 倍
    expect(sell.notionalUsd).toBeCloseTo(500 * 1.4, 6)
    // ムーンバッグ化: 全ルール（損切り含む）が発動済み扱いになり、以後の売却は起きない
    const meta = current.positionMeta[good.token.pairAddress]
    expect(meta.moonbagAt).toBeDefined()
    expect(meta.triggered).toHaveLength(current.ladderRules.length)
  })

  it('ムーンバッグ化後は損切りラインを割っても売却しない（完全放置）', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeMoonbagSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []

    setPrice(store, good, 0.002) // +100% → ムーンバッグ化
    await store._processSession(session.id)
    const ordersAfterTp = store.sessionById(session.id)!.portfolio.orders.length

    setPrice(store, good, 0.0004) // エントリー比 -60%（損切りライン -50% を下回る）
    await store._processSession(session.id)

    const current = store.sessionById(session.id)!
    expect(current.portfolio.orders).toHaveLength(ordersAfterTp) // 新規売却なし
    expect(positionOf(current.portfolio, good.token.pairAddress)).toBeTruthy() // 保持継続
    // 監視対象からも外れない（評価額の表示は継続する）
    expect(current.watchedPairs).toContain(good.token.pairAddress)
  })

  it('ムーンバッグ化した保有は同時ポジション数に数えない（新規エントリーが継続する）', async () => {
    const first = freshScore({ priceUsd: 0.001 })
    const store = setupStore([first], makeMoonbagSession(1)) // 最大同時 1
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    expect(store.sessionById(session.id)!.portfolio.positions).toHaveLength(1)

    // 枠が埋まっている間は新候補に入らない
    const second = freshScore()
    store.freshTokens = [second]
    store.freshSeenAt[second.token.pairAddress] = Date.now()
    await store._autoSnipeEntries(session.id)
    expect(store.sessionById(session.id)!.portfolio.positions).toHaveLength(1)

    // first がムーンバッグ化すると枠が空き、second へエントリーする
    setPrice(store, first, 0.002)
    store.freshTokens = []
    await store._processSession(session.id)
    store.freshTokens = [second]
    store.freshSeenAt[second.token.pairAddress] = Date.now()
    await store._autoSnipeEntries(session.id)

    const current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(2) // ムーンバッグ + 新規
    expect(positionOf(current.portfolio, second.token.pairAddress)).toBeTruthy()
    // 集計ゲッターはムーンバッグのみを数える
    expect(store.moonbagStatsOf(session.id).count).toBe(1)
  })

  it('+100% 未到達で損切りラインに到達したら全決済し、監視から剪定される', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeMoonbagSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []

    setPrice(store, good, 0.00045) // -55%（損切りライン -50% を下回る）
    await store._processSession(session.id)

    const current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, good.token.pairAddress)).toBeUndefined()
    const sell = current.portfolio.orders.find((o) => o.side === 'sell')!
    expect(sell.reason).toContain('ラダー損切り')
    expect(current.watchedPairs).not.toContain(good.token.pairAddress)
  })

  it('損切りなし（null）の設定では下落しても売却しない', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeMoonbagSession(2, null))
    const session = store.sessions[0]
    expect(store.sessions[0].ladderRules).toHaveLength(1) // 利確のみ
    await store._autoSnipeEntries(session.id)
    store.freshTokens = []

    setPrice(store, good, 0.0001) // -90%
    await store._processSession(session.id)

    const current = store.sessionById(session.id)!
    expect(current.portfolio.orders.filter((o) => o.side === 'sell')).toHaveLength(0)
    expect(positionOf(current.portfolio, good.token.pairAddress)).toBeTruthy()
  })

  it('保有中ミントは履歴の 200 件間引きから保護され、別プールへの再エントリーも塞がれる', async () => {
    const held = freshScore({ priceUsd: 0.001 })
    const store = setupStore([held], makeMoonbagSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    setPrice(store, held, 0.002)
    store.freshTokens = []
    await store._processSession(session.id) // ムーンバッグ化

    // 長期運用を再現: エントリー履歴が上限を大きく超え、保有中ミントが最古側にある
    let current = store.sessionById(session.id)!
    current.enteredMints = [held.token.baseAddress, ...Array.from({ length: 250 }, (_, i) => `MINThist${i}`)]
    current.enteredPairs = [held.token.pairAddress, ...Array.from({ length: 250 }, (_, i) => `PAIRhist${i}`)]
    store._pruneClosedAutoPairs(current)
    // 最古でも保有中の分は間引かれない
    expect(current.enteredMints).toContain(held.token.baseAddress)
    expect(current.enteredPairs).toContain(held.token.pairAddress)
    expect(current.enteredMints.length).toBeLessThanOrEqual(201)

    // 保護分が上限以上の極限ケース: 非保護は全て間引かれ、保護のみ残る（slice(-0) 全残バグの回帰: L36）
    const manyHeld = makeMoonbagSession(2)
    const heldPairs = Array.from({ length: 200 }, (_, i) => `Aheld${i}${'1'.repeat(36)}`.slice(0, 44))
    manyHeld.portfolio = {
      ...createPortfolio(1_000),
      positions: heldPairs.map((addr) => ({ assetId: addr, quantity: 1, avgCostUsd: 1 })),
    }
    manyHeld.positionMeta = Object.fromEntries(
      heldPairs.map((addr, i) => [addr, { entryPriceUsd: 1, triggered: [0], moonbagAt: 1, mint: `M${i}` }]),
    )
    manyHeld.watchedPairs = [...heldPairs]
    manyHeld.enteredMints = [...heldPairs.map((_, i) => `M${i}`), ...Array.from({ length: 50 }, (_, i) => `Mold${i}`)]
    store.sessions.push(manyHeld)
    store._pruneClosedAutoPairs(manyHeld)
    expect(manyHeld.enteredMints).toHaveLength(200) // 保護 200 のみ・非保護 50 は全て間引き
    expect(manyHeld.enteredMints.every((m) => !m.startsWith('Mold'))).toBe(true)

    // さらに履歴から消えた場合でも、保有中ミントの別プールには positionMeta.mint 照合で入らない
    current.enteredMints = current.enteredMints.filter((m) => m !== held.token.baseAddress)
    const samePairNewPool = freshScore({
      pairAddress: 'PAIRnewpool111111111111111111111111111111111'.slice(0, 44),
      baseAddress: held.token.baseAddress,
    })
    store.freshTokens = [samePairNewPool]
    store.freshFetchedAt = Date.now()
    store.freshSeenAt = { [samePairNewPool.token.pairAddress]: Date.now() }
    await store._autoSnipeEntries(session.id)
    current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, samePairNewPool.token.pairAddress)).toBeUndefined()
  })

  it('価格更新の優先順はセッション横断: 他セッションでアクティブ保有ならムーンバッグでも先頭バケット', async () => {
    // isValidAddress（base58）を通る実在形式のアドレスにする（I/O/0/l は base58 に存在しない）
    const shared = freshScore({
      priceUsd: 0.001,
      pairAddress: `Ashared${'A'.repeat(37)}`,
      baseAddress: `Bshared${'B'.repeat(37)}`,
    })
    const store = setupStore([shared], makeMoonbagSession(2))
    const moonbagSession = store.sessions[0]
    await store._autoSnipeEntries(moonbagSession.id)
    setPrice(store, shared, 0.002)
    store.freshTokens = []
    await store._processSession(moonbagSession.id) // moonbag セッション側はムーンバッグ化

    // 同一ペアをアクティブ保有する別セッション（ラダー継続中）を追加
    const activeSession = makeMoonbagSession(2)
    activeSession.method = 'ladder'
    activeSession.portfolio = {
      ...createPortfolio(1_000),
      positions: [{ assetId: shared.token.pairAddress, quantity: 100, avgCostUsd: 0.001 }],
    }
    activeSession.positionMeta = {
      [shared.token.pairAddress]: { entryPriceUsd: 0.001, triggered: [] },
    }
    store.sessions.push(activeSession)

    // moonbag セッションが配列先頭でも、横断判定でアクティブ扱い（先頭バケット）になる
    const targets = store._priceRefreshTargets()
    expect(targets[0]).toBe(shared.token.pairAddress)
  })

  it('ムーンバッグが複数ある場合の価格更新はローテーションで順繰りに先頭が変わる', () => {
    const store = useSolanaStore()
    const session = makeMoonbagSession(3)
    // base58 で有効な形式（isValidAddress を通す）
    const pairs = [`ArotA${'1'.repeat(39)}`, `BrotB${'1'.repeat(39)}`, `CrotC${'1'.repeat(39)}`]
    session.portfolio = {
      ...createPortfolio(1_000),
      positions: pairs.map((addr) => ({ assetId: addr, quantity: 10, avgCostUsd: 1 })),
    }
    session.positionMeta = Object.fromEntries(
      pairs.map((addr) => [addr, { entryPriceUsd: 1, triggered: [0], moonbagAt: Date.now() }]),
    )
    store.sessions = [session]

    const first = store._priceRefreshTargets()
    const second = store._priceRefreshTargets()
    expect(new Set(first)).toEqual(new Set(second)) // 集合は同じ
    expect(first[0]).not.toBe(second[0]) // 先頭（更新窓）が回転する
  })

  it('moonbagStatsOf の評価額は現在価格で計算される', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const store = setupStore([good], makeMoonbagSession(2))
    const session = store.sessions[0]
    await store._autoSnipeEntries(session.id)
    setPrice(store, good, 0.002)
    store.freshTokens = []
    await store._processSession(session.id)

    // 残 30%（qty 150,000）× 現在価格 0.004 = $600
    setPrice(store, good, 0.004)
    const stats = store.moonbagStatsOf(session.id)
    expect(stats.count).toBe(1)
    expect(stats.valueUsd).toBeCloseTo(150_000 * 0.004, 6)
  })

  it('復元時は moonbagStopLossPct を正規化し、ラダールールを設定から再構築する（設定が SoT）', async () => {
    const corrupt = makeMoonbagSession(2, -50)
    corrupt.running = false
    corrupt.moonbagStopLossPct = -500 // 改変データ → -90 にクランプ
    corrupt.ladderRules = [] // ルール欠落 → 設定から再構築
    const noStop = makeMoonbagSession(2, null)
    noStop.running = false
    noStop.ladderRules = buildMoonbagLadder(-30) // 設定（null）と矛盾 → 設定を優先
    saveLocal('solana-degen', { sessions: [corrupt, noStop], archives: [] })

    const store = useSolanaStore()
    await store.restoreState()

    const [a, b] = store.sessions
    expect(a.moonbagStopLossPct).toBe(-90)
    expect(a.ladderRules).toEqual(buildMoonbagLadder(-90))
    expect(b.moonbagStopLossPct).toBeNull()
    expect(b.ladderRules).toEqual(buildMoonbagLadder(null))
  })
})

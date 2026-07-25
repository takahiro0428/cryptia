import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { scoreFreshToken, type FreshTokenSignals, type SnipeScore } from '~/shared/snipeScoring'
import { createPortfolio, positionOf } from '~/shared/tradeEngine'
import type { SolanaToken } from '~/shared/types'
import {
  DEFAULT_AUTO_SNIPE,
  useSolanaStore,
  type DegenSession,
} from '~/stores/solana'
import { SNIPE_LADDER_RULES } from '~/shared/snipeScoring'

/**
 * 自動スナイプ（常時監視）の結合テスト。
 * ネットワークは遮断し、監視データ（freshTokens）を直接投入して
 * エントリーゲート・枠管理・再エントリー防止を検証する。
 */

let seq = 0
function freshScore(
  tokenOverrides: Partial<SolanaToken> = {},
  signalOverrides: Partial<FreshTokenSignals> = {},
): SnipeScore {
  seq++
  const token: SolanaToken = {
    pairAddress: `PAIRauto${seq}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44),
    baseSymbol: `NEW${seq}`,
    baseName: `New Token ${seq}`,
    baseAddress: `MINTauto${seq}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx`.slice(0, 44),
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

function makeSession(maxPositions = 2, allowCaution = false): DegenSession {
  return {
    id: `test-session-${++seq}`,
    name: 'テスト',
    createdAt: Date.now(),
    portfolio: createPortfolio(1_000),
    running: true,
    method: 'auto-snipe',
    ladderRules: [...SNIPE_LADDER_RULES],
    watchedPairs: [],
    positionMeta: {},
    autoSnipe: { ...DEFAULT_AUTO_SNIPE, maxPositions, allowCaution },
    enteredPairs: [],
    enteredMints: [],
  }
}

function setupStore(scores: SnipeScore[], maxPositions = 2, allowCaution = false) {
  const store = useSolanaStore()
  const session = makeSession(maxPositions, allowCaution)
  store.sessions = [session]
  store.usingMockData = false
  store.freshFetchedAt = Date.now() // TTL 内 → fetchFreshTokens は即 return し投入データを維持
  store.freshTokens = scores
  store.freshSeenAt = Object.fromEntries(
    scores.map((s) => [s.token.pairAddress, Date.now()]),
  )
  return { store, session }
}

describe('自動スナイプ: 監視 → 監査 → 随時エントリー', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  it('監査通過トークンのみへ、空き枠の数だけ等分予算でエントリーする', async () => {
    const good1 = freshScore()
    const avoid = freshScore({ liquidityUsd: 1_000 }) // ラグプル警告 → 回避
    const good2 = freshScore()
    const good3 = freshScore() // 枠不足で入らない
    const { store, session } = setupStore([good1, avoid, good2, good3], 2)

    await store._autoSnipeEntries(session.id)

    const current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(2)
    expect(positionOf(current.portfolio, good1.token.pairAddress)).toBeTruthy()
    expect(positionOf(current.portfolio, good2.token.pairAddress)).toBeTruthy()
    expect(positionOf(current.portfolio, avoid.token.pairAddress)).toBeUndefined()
    // 1 枠 = 割当資金 / 最大同時数 = $500
    expect(current.portfolio.orders[0].notionalUsd).toBeCloseTo(500, 6)
    expect(current.portfolio.orders.every((o) => o.reason.includes('監査通過'))).toBe(true)
    expect(current.portfolio.orders.every((o) => o.strategy === '自動スナイプ')).toBe(true)
    // 監視対象・エントリー履歴・ラダー用メタが揃う
    expect(current.watchedPairs).toContain(good1.token.pairAddress)
    expect(current.enteredPairs).toHaveLength(2)
    expect(current.enteredMints).toHaveLength(2)
    expect(current.positionMeta[good1.token.pairAddress].entryPriceUsd).toBe(good1.token.priceUsd)
  })

  it('一度エントリーしたトークンには全決済後も再エントリーしない', async () => {
    const good1 = freshScore()
    const good2 = freshScore()
    const good3 = freshScore()
    const { store, session } = setupStore([good1, good2, good3], 2)

    await store._autoSnipeEntries(session.id)
    let current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(2)

    // good1 を全決済した状態を再現（ポジション除去 + 売却代金の入金。注文履歴は追記型のため保持）
    current.portfolio = {
      ...current.portfolio,
      cashUsd: current.portfolio.cashUsd + 500,
      positions: current.portfolio.positions.filter(
        (p) => p.assetId !== good1.token.pairAddress,
      ),
    }
    await store._autoSnipeEntries(session.id)

    // 空き枠には good3 が入り、good1 へは戻らない
    current = store.sessionById(session.id)!
    expect(positionOf(current.portfolio, good3.token.pairAddress)).toBeTruthy()
    expect(positionOf(current.portfolio, good1.token.pairAddress)).toBeUndefined()
    expect(current.enteredPairs).toHaveLength(3)
  })

  it('発見フィードで5分以内に確認できていないエントリーは執行対象にしない（鮮度ゲート）', async () => {
    const staleSeen = freshScore()
    const freshSeen = freshScore()
    const { store, session } = setupStore([staleSeen, freshSeen], 2)
    // staleSeen はフィード落ちして 10 分未確認、freshSeen は直近確認
    store.freshSeenAt = {
      [staleSeen.token.pairAddress]: Date.now() - 10 * 60 * 1000,
      [freshSeen.token.pairAddress]: Date.now(),
    }
    await store._autoSnipeEntries(session.id)
    const current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(1)
    expect(positionOf(current.portfolio, freshSeen.token.pairAddress)).toBeTruthy()
    expect(positionOf(current.portfolio, staleSeen.token.pairAddress)).toBeUndefined()
  })

  it('再エントリー防止はミント単位（代表ペアが変わっても同一トークンへ再エントリーしない）', async () => {
    const first = freshScore()
    const { store, session } = setupStore([first], 2)
    await store._autoSnipeEntries(session.id)
    let current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(1)

    // 全決済 + 同一ミントの別ペアがプールに現れた状態を再現
    current.portfolio = {
      ...current.portfolio,
      cashUsd: current.portfolio.cashUsd + 500,
      positions: [],
    }
    const samePairDifferentPool = freshScore({
      pairAddress: 'PAIRmigrated1111111111111111111111111111111'.slice(0, 44),
      baseAddress: first.token.baseAddress,
    })
    store.freshTokens = [samePairDifferentPool]
    store.freshFetchedAt = Date.now()
    store.freshSeenAt = { [samePairDifferentPool.token.pairAddress]: Date.now() }
    await store._autoSnipeEntries(session.id)
    current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(0)
  })

  it('監査基準「要注意まで許容」で caution 判定にもエントリーする', async () => {
    const caution = freshScore(
      {},
      {
        hasTwitter: false,
        hasTelegram: false,
        mintAuthorityRenounced: null,
        freezeAuthorityAbsent: null,
        buys24h: 10,
        sells24h: 10,
      },
    )
    expect(caution.verdict).toBe('caution')

    const strict = setupStore([caution], 2, false)
    await strict.store._autoSnipeEntries(strict.session.id)
    expect(strict.store.sessionById(strict.session.id)!.portfolio.positions).toHaveLength(0)

    setActivePinia(createPinia())
    const loose = setupStore([caution], 2, true)
    await loose.store._autoSnipeEntries(loose.session.id)
    expect(loose.store.sessionById(loose.session.id)!.portfolio.positions).toHaveLength(1)
  })

  it('モックデータ中・監視データが古い場合はエントリーしない（実勢乖離の防止）', async () => {
    const good = freshScore()

    const mock = setupStore([good])
    mock.store.usingMockData = true
    await mock.store._autoSnipeEntries(mock.session.id)
    expect(mock.store.sessionById(mock.session.id)!.portfolio.positions).toHaveLength(0)

    setActivePinia(createPinia())
    const stale = setupStore([good])
    stale.store.freshFetchedAt = Date.now() - 10 * 60 * 1000
    await stale.store._autoSnipeEntries(stale.session.id)
    expect(stale.store.sessionById(stale.session.id)!.portfolio.positions).toHaveLength(0)
  })

  it('セッションが終了済み・一時停止中なら旧判断を破棄する（ISSUE-3 と同水準の保護）', async () => {
    const { store, session } = setupStore([freshScore()])
    store.sessions = [] // 終了済み
    await store._autoSnipeEntries(session.id)
    expect(session.portfolio.positions).toHaveLength(0)

    setActivePinia(createPinia())
    const paused = setupStore([freshScore()])
    paused.session.running = false
    await paused.store._autoSnipeEntries(paused.session.id)
    expect(paused.store.sessionById(paused.session.id)!.portfolio.positions).toHaveLength(0)
  })

  it('執行直前に個別取得した最新価格でエントリーする（監視キャッシュ価格を上書き）', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    // pairs 個別取得だけ成功させ、最新価格 0.002 を返す
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: unknown) => {
        if (String(url).includes('/latest/dex/pairs/')) {
          return {
            ok: true,
            json: async () => ({
              pairs: [
                {
                  chainId: 'solana',
                  pairAddress: good.token.pairAddress,
                  baseToken: { address: good.token.baseAddress, name: good.token.baseName, symbol: good.token.baseSymbol },
                  priceUsd: '0.002',
                  liquidity: { usd: good.token.liquidityUsd },
                  volume: { h24: good.token.volume24hUsd },
                  priceChange: { h24: 0 },
                  pairCreatedAt: Date.now() - 3 * 3_600_000,
                },
              ],
            }),
          }
        }
        throw new Error('offline')
      }),
    )
    const { store, session } = setupStore([good], 1)
    await store._autoSnipeEntries(session.id)
    const current = store.sessionById(session.id)!
    expect(current.portfolio.positions).toHaveLength(1)
    expect(current.portfolio.orders[0].priceUsd).toBe(0.002)
    expect(current.positionMeta[good.token.pairAddress].entryPriceUsd).toBe(0.002)
  })

  it('全量決済済みペアは監視対象・メタから剪定され、エントリー履歴は上限で間引かれる', () => {
    setActivePinia(createPinia())
    const store = useSolanaStore()
    const held = freshScore()
    const closed = freshScore()
    const session = makeSession()
    session.portfolio = {
      ...createPortfolio(1_000),
      positions: [{ assetId: held.token.pairAddress, quantity: 100, avgCostUsd: 1 }],
    }
    session.watchedPairs = [closed.token.pairAddress, held.token.pairAddress]
    session.positionMeta = {
      [closed.token.pairAddress]: { entryPriceUsd: 1, triggered: [0] },
      [held.token.pairAddress]: { entryPriceUsd: 1, triggered: [] },
    }
    session.enteredPairs = Array.from({ length: 250 }, (_, i) => `PAIRhist${i}`)
    session.enteredMints = Array.from({ length: 250 }, (_, i) => `MINThist${i}`)
    store.sessions = [session]

    store._pruneClosedAutoPairs(store.sessions[0])

    const pruned = store.sessions[0]
    expect(pruned.watchedPairs).toEqual([held.token.pairAddress])
    expect(Object.keys(pruned.positionMeta)).toEqual([held.token.pairAddress])
    expect(pruned.enteredPairs).toHaveLength(200)
    expect(pruned.enteredMints).toHaveLength(200)
    // 直近の履歴が残る（古い側から間引く）
    expect(pruned.enteredPairs[199]).toBe('PAIRhist249')
  })

  it('複数セッションが同一プールを共有しつつ独立にエントリーする', async () => {
    const good1 = freshScore()
    const good2 = freshScore()
    const { store, session } = setupStore([good1, good2], 1)
    const second = makeSession(1)
    store.sessions.push(second)

    await store._autoSnipeEntries(session.id)
    await store._autoSnipeEntries(second.id)

    // 各セッションは自分の枠（1）でエントリーし、互いのエントリー履歴に干渉しない
    const a = store.sessionById(session.id)!
    const b = store.sessionById(second.id)!
    expect(a.portfolio.positions).toHaveLength(1)
    expect(b.portfolio.positions).toHaveLength(1)
    // 同じおすすめ順で評価するため、両セッションとも先頭の good1 に入る（独立予算）
    expect(positionOf(a.portfolio, good1.token.pairAddress)).toBeTruthy()
    expect(positionOf(b.portfolio, good1.token.pairAddress)).toBeTruthy()
  })
})

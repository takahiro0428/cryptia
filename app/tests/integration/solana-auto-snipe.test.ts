import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { scoreFreshToken, type FreshTokenSignals, type SnipeScore } from '~/shared/snipeScoring'
import { createPortfolio, positionOf } from '~/shared/tradeEngine'
import type { SolanaToken } from '~/shared/types'
import { useSolanaStore } from '~/stores/solana'

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

function setupStore(scores: SnipeScore[], maxPositions = 2, allowCaution = false) {
  const store = useSolanaStore()
  store.portfolio = createPortfolio(1_000)
  store.method = 'auto-snipe'
  store.running = true
  store.autoSnipe = { maxPositions, allowCaution }
  store.usingMockData = false
  store.freshFetchedAt = Date.now() // TTL 内 → fetchFreshTokens は即 return し投入データを維持
  store.freshTokens = scores
  return store
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
    const store = setupStore([good1, avoid, good2, good3], 2)

    await store._autoSnipeEntries(store._session)

    expect(store.portfolio!.positions).toHaveLength(2)
    expect(positionOf(store.portfolio!, good1.token.pairAddress)).toBeTruthy()
    expect(positionOf(store.portfolio!, good2.token.pairAddress)).toBeTruthy()
    expect(positionOf(store.portfolio!, avoid.token.pairAddress)).toBeUndefined()
    // 1 枠 = 割当資金 / 最大同時数 = $500
    expect(store.portfolio!.orders[0].notionalUsd).toBeCloseTo(500, 6)
    expect(store.portfolio!.orders.every((o) => o.reason.includes('監査通過'))).toBe(true)
    expect(store.portfolio!.orders.every((o) => o.strategy === '自動スナイプ')).toBe(true)
    // 監視対象・エントリー履歴・ラダー用メタが揃う
    expect(store.watchedPairs).toContain(good1.token.pairAddress)
    expect(store.enteredPairs).toHaveLength(2)
    expect(store.positionMeta[good1.token.pairAddress].entryPriceUsd).toBe(good1.token.priceUsd)
  })

  it('一度エントリーしたトークンには全決済後も再エントリーしない', async () => {
    const good1 = freshScore()
    const good2 = freshScore()
    const good3 = freshScore()
    const store = setupStore([good1, good2, good3], 2)

    await store._autoSnipeEntries(store._session)
    expect(store.portfolio!.positions).toHaveLength(2)

    // good1 を全決済した状態を再現（ポジション除去 + 売却代金の入金。注文履歴は追記型のため保持）
    store.portfolio = {
      ...store.portfolio!,
      cashUsd: store.portfolio!.cashUsd + 500,
      positions: store.portfolio!.positions.filter(
        (p) => p.assetId !== good1.token.pairAddress,
      ),
    }
    await store._autoSnipeEntries(store._session)

    // 空き枠には good3 が入り、good1 へは戻らない
    expect(positionOf(store.portfolio!, good3.token.pairAddress)).toBeTruthy()
    expect(positionOf(store.portfolio!, good1.token.pairAddress)).toBeUndefined()
    expect(store.enteredPairs).toHaveLength(3)
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
    await strict._autoSnipeEntries(strict._session)
    expect(strict.portfolio!.positions).toHaveLength(0)

    setActivePinia(createPinia())
    const loose = setupStore([caution], 2, true)
    await loose._autoSnipeEntries(loose._session)
    expect(loose.portfolio!.positions).toHaveLength(1)
  })

  it('発見フィードで5分以内に確認できていないエントリーは執行対象にしない（鮮度ゲート）', async () => {
    const staleSeen = freshScore()
    const freshSeen = freshScore()
    const store = setupStore([staleSeen, freshSeen], 2)
    // staleSeen はフィード落ちして 10 分未確認、freshSeen は直近確認
    store.freshSeenAt = {
      [staleSeen.token.pairAddress]: Date.now() - 10 * 60 * 1000,
      [freshSeen.token.pairAddress]: Date.now(),
    }
    await store._autoSnipeEntries(store._session)
    expect(store.portfolio!.positions).toHaveLength(1)
    expect(positionOf(store.portfolio!, freshSeen.token.pairAddress)).toBeTruthy()
    expect(positionOf(store.portfolio!, staleSeen.token.pairAddress)).toBeUndefined()
  })

  it('再エントリー防止はミント単位（代表ペアが変わっても同一トークンへ再エントリーしない）', async () => {
    const first = freshScore()
    const store = setupStore([first], 2)
    await store._autoSnipeEntries(store._session)
    expect(store.portfolio!.positions).toHaveLength(1)

    // 全決済 + 同一ミントの別ペアがプールに現れた状態を再現
    store.portfolio = {
      ...store.portfolio!,
      cashUsd: store.portfolio!.cashUsd + 500,
      positions: [],
    }
    const samePairDifferentPool = freshScore({
      pairAddress: 'PAIRmigrated1111111111111111111111111111111'.slice(0, 44),
      baseAddress: first.token.baseAddress,
    })
    store.freshTokens = [samePairDifferentPool]
    store.freshFetchedAt = Date.now()
    store.freshSeenAt = { [samePairDifferentPool.token.pairAddress]: Date.now() }
    await store._autoSnipeEntries(store._session)
    expect(store.portfolio!.positions).toHaveLength(0)
  })

  it('モックデータ中・監視データが古い場合はエントリーしない（実勢乖離の防止）', async () => {
    const good = freshScore()

    const mock = setupStore([good])
    mock.usingMockData = true
    await mock._autoSnipeEntries(mock._session)
    expect(mock.portfolio!.positions).toHaveLength(0)

    setActivePinia(createPinia())
    const stale = setupStore([good])
    stale.freshFetchedAt = Date.now() - 10 * 60 * 1000
    await stale._autoSnipeEntries(stale._session)
    expect(stale.portfolio!.positions).toHaveLength(0)
  })

  it('セッション世代が変わっていたら旧判断を破棄する（ISSUE-3 と同水準の保護）', async () => {
    const store = setupStore([freshScore()])
    const oldSession = store._session
    store._session++
    await store._autoSnipeEntries(oldSession)
    expect(store.portfolio!.positions).toHaveLength(0)
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
    const store = setupStore([good], 1)
    await store._autoSnipeEntries(store._session)
    expect(store.portfolio!.positions).toHaveLength(1)
    expect(store.portfolio!.orders[0].priceUsd).toBe(0.002)
    expect(store.positionMeta[good.token.pairAddress].entryPriceUsd).toBe(0.002)
  })

  it('全量決済済みペアは監視対象・メタから剪定され、エントリー履歴は上限で間引かれる', () => {
    setActivePinia(createPinia())
    const store = useSolanaStore()
    const held = freshScore()
    const closed = freshScore()
    store.method = 'auto-snipe'
    store.portfolio = {
      ...createPortfolio(1_000),
      positions: [{ assetId: held.token.pairAddress, quantity: 100, avgCostUsd: 1 }],
    }
    store.watchedPairs = [closed.token.pairAddress, held.token.pairAddress]
    store.positionMeta = {
      [closed.token.pairAddress]: { entryPriceUsd: 1, triggered: [0] },
      [held.token.pairAddress]: { entryPriceUsd: 1, triggered: [] },
    }
    store.enteredPairs = Array.from({ length: 250 }, (_, i) => `PAIRhist${i}`)

    store._pruneClosedAutoPairs()

    expect(store.watchedPairs).toEqual([held.token.pairAddress])
    expect(Object.keys(store.positionMeta)).toEqual([held.token.pairAddress])
    expect(store.enteredPairs).toHaveLength(200)
    // 直近の履歴が残る（古い側から間引く）
    expect(store.enteredPairs[199]).toBe('PAIRhist249')
  })
})

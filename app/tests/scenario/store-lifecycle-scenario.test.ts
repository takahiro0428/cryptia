import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { ASSETS } from '~/shared/assets'
import { STRATEGY_PRESETS } from '~/shared/strategyPresets'
import { useDemoTradeStore } from '~/stores/demoTrade'
import { useMarketStore } from '~/stores/market'
import { useStrategyStore } from '~/stores/strategy'

/**
 * シナリオテスト: ストア横断のライフサイクル
 * 「戦略を選ぶ（UC-7）→ デモトレードを開始（UC-4）→ ティック実行 →
 *  セッション終了でアーカイブ保護（BR-7）→ 再開始しても過去記録が残る」
 */
describe('シナリオ: 戦略設定 → デモトレード → アーカイブ', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    // 価格 API は失敗させ、モックフォールバックで動かす（オフラインシナリオ）
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  it('一連のユーザーストーリーが破綻なく流れる', async () => {
    const market = useMarketStore()
    await market.fetchTickers()
    expect(market.usingMockData).toBe(true)

    // UC-7: 戦略を画面別に切り替える（デモ画面のみ変更 → 他画面は既定のまま）
    const strategy = useStrategyStore()
    await strategy.restoreState()
    strategy.setActiveFor('demo', 'preset-breakout')
    expect(strategy.docFor('demo').name).toBe('ブレイクアウト追撃')
    expect(strategy.docFor('solana').id).toBe('preset-degen-ladder')

    // カスタム戦略の追加 → 全画面へ一括適用
    const custom = strategy.addCustom({
      name: 'テスト戦略',
      content: '- テスト用のルール',
      riskLevel: 2,
    })
    strategy.setActiveAll(custom.id)
    expect(strategy.docFor('demo').builtin).toBe(false)
    expect(strategy.docFor('insights').id).toBe(custom.id)

    // UC-4: デモトレード開始（ロジックエンジン）
    const demo = useDemoTradeStore()
    demo.start(10_000, ['bitcoin', 'ethereum', 'solana'], 'logic')
    expect(demo.sessions).toHaveLength(1)
    const sessionId = demo.sessions[0].id
    expect(demo.sessions[0].running).toBe(true)

    // ティックを直接実行（タイマー非依存）
    await demo.tick()
    await demo.tick()
    expect(demo.sessions[0].portfolio.equityCurve.length).toBeGreaterThan(1)
    const ordersAfterTicks = demo.sessions[0].portfolio.orders.length

    // セッション終了 → アーカイブへ（注文があれば保護される）
    demo.endSession(sessionId)
    expect(demo.sessions).toHaveLength(0)
    if (ordersAfterTicks > 0) {
      expect(demo.archives).toHaveLength(1)
      expect(demo.archives[0].summary.tradeCount).toBe(ordersAfterTicks)
      // 約定履歴が閲覧用に保存される（F-04）
      expect(demo.archives[0].orders).toBeDefined()
      expect(demo.archives[0].orders!.length).toBe(Math.min(ordersAfterTicks, 100))
      expect(demo.archives[0].orders![0].reason.length).toBeGreaterThan(0)
    }

    // 再開始してもアーカイブは残る（冪等性と状態保護: 原則2）
    const archiveCount = demo.archives.length
    demo.start(5_000, ['solana'], 'logic')
    expect(demo.archives.length).toBe(archiveCount)
    demo.pause(demo.sessions[0].id)

    vi.unstubAllGlobals()
  })

  it('複数セッションを同時に実行でき、個別に一時停止・終了できる', async () => {
    const market = useMarketStore()
    await market.fetchTickers()
    const demo = useDemoTradeStore()
    demo.start(10_000, ['bitcoin'], 'logic', 'A')
    demo.start(5_000, ['ethereum'], 'logic', 'B')
    expect(demo.sessions).toHaveLength(2)
    expect(demo.anyRunning).toBe(true)

    const [a, b] = demo.sessions
    // ティックは両セッションを処理する
    await demo.tick()
    expect(demo.sessionById(a.id)).toBeTruthy()
    expect(demo.sessionById(b.id)).toBeTruthy()

    // A を一時停止しても B は実行中のまま
    demo.pause(a.id)
    expect(demo.sessionById(a.id)!.running).toBe(false)
    expect(demo.sessionById(b.id)!.running).toBe(true)

    // B を終了しても A は残る
    demo.endSession(b.id)
    expect(demo.sessions).toHaveLength(1)
    expect(demo.sessions[0].id).toBe(a.id)
    demo.endSession(a.id)
    vi.unstubAllGlobals()
  })

  it('セッション数の上限を超える開始はブロックされる', async () => {
    const market = useMarketStore()
    await market.fetchTickers()
    const demo = useDemoTradeStore()
    for (let i = 0; i < 6; i++) demo.start(1_000, ['bitcoin'], 'logic')
    expect(demo.sessions.length).toBeLessThanOrEqual(5)
    for (const s of [...demo.sessions]) demo.endSession(s.id)
    vi.unstubAllGlobals()
  })

  it('AI おすすめ銘柄が銘柄マスタの範囲内で返る', async () => {
    const market = useMarketStore()
    await market.fetchTickers()
    const demo = useDemoTradeStore()
    const rec = demo.recommendedAssets(4)
    expect(rec.length).toBeGreaterThan(0)
    expect(rec.length).toBeLessThanOrEqual(4)
    const validIds = new Set(ASSETS.map((a) => a.id))
    for (const r of rec) {
      expect(validIds.has(r.assetId)).toBe(true)
      expect(r.summary.length).toBeGreaterThan(0)
    }
    vi.unstubAllGlobals()
  })

  it('戦略の削除でプリセットは保護され、適用中の画面は各画面の既定へ戻る', async () => {
    const strategy = useStrategyStore()
    await strategy.restoreState()
    const custom = strategy.addCustom({ name: '削除対象', content: 'x', riskLevel: 3 })
    strategy.setActiveAll(custom.id)
    strategy.removeCustom(custom.id)
    // 画面ごとの既定戦略へ戻る（全画面共通の先頭プリセットではない）
    expect(strategy.docFor('demo').id).toBe('preset-momentum')
    expect(strategy.docFor('solana').id).toBe('preset-degen-ladder')
    expect(strategy.docFor('live').id).toBe('preset-dca')
    // プリセットは削除できない
    strategy.removeCustom(STRATEGY_PRESETS[0].id)
    expect(strategy.allDocs.some((d) => d.id === STRATEGY_PRESETS[0].id)).toBe(true)
  })

  it('旧形式（全画面共通 activeId）の保存データは全画面へ移行される（原則7）', async () => {
    localStorage.setItem(
      'cryptia:strategies',
      JSON.stringify({ savedAt: 1, data: { customDocs: [], activeId: 'preset-breakout' } }),
    )
    const strategy = useStrategyStore()
    await strategy.restoreState()
    expect(strategy.docFor('demo').id).toBe('preset-breakout')
    expect(strategy.docFor('insights').id).toBe('preset-breakout')
    expect(strategy.docFor('live').id).toBe('preset-breakout')
  })
})

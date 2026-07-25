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
    expect(demo.portfolio).not.toBeNull()
    expect(demo.running).toBe(true)

    // ティックを直接実行（タイマー非依存）
    await demo.tick()
    await demo.tick()
    expect(demo.portfolio!.equityCurve.length).toBeGreaterThan(1)
    const ordersAfterTicks = demo.portfolio!.orders.length

    // セッション終了 → アーカイブへ（注文があれば保護される）
    demo.endSession()
    expect(demo.portfolio).toBeNull()
    expect(demo.running).toBe(false)
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
    demo.stop()

    vi.unstubAllGlobals()
  })

  it('多重開始はブロックされ、既存セッションが破壊されない（冪等性）', async () => {
    const market = useMarketStore()
    await market.fetchTickers()
    const demo = useDemoTradeStore()
    demo.start(10_000, ['bitcoin'], 'logic')
    const firstPortfolio = demo.portfolio
    demo.start(99_999, ['ethereum'], 'logic') // 2回目は無視される
    expect(demo.portfolio).toBe(firstPortfolio)
    demo.stop()
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

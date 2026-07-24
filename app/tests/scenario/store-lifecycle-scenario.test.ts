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

    // UC-7: 戦略を切り替える
    const strategy = useStrategyStore()
    await strategy.restoreState()
    strategy.setActive('preset-breakout')
    expect(strategy.activeDoc.name).toBe('ブレイクアウト追撃')

    // カスタム戦略の追加 → 有効化
    const custom = strategy.addCustom({
      name: 'テスト戦略',
      content: '- テスト用のルール',
      riskLevel: 2,
    })
    strategy.setActive(custom.id)
    expect(strategy.activeDoc.builtin).toBe(false)

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

  it('戦略の削除でプリセットは保護され、有効戦略はデフォルトへ戻る', async () => {
    const strategy = useStrategyStore()
    await strategy.restoreState()
    const custom = strategy.addCustom({ name: '削除対象', content: 'x', riskLevel: 3 })
    strategy.setActive(custom.id)
    strategy.removeCustom(custom.id)
    expect(strategy.activeId).toBe(STRATEGY_PRESETS[0].id)
    // プリセットは削除できない
    strategy.removeCustom(STRATEGY_PRESETS[0].id)
    expect(strategy.allDocs.some((d) => d.id === STRATEGY_PRESETS[0].id)).toBe(true)
  })
})

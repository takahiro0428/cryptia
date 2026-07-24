import { describe, expect, it } from 'vitest'
import { validateAssetId, validateHorizon, validateStrategy, validateTicker } from '~/server/utils/validation'
import { mockTickers } from '~/shared/mockData'

/**
 * 結合テスト: サーバー API 入力検証（NFR: 全入力検証）。
 * 不正入力が 400 エラー（statusCode 付き）で拒否されることを検証する。
 */
describe('サーバー入力検証結合', () => {
  it('validateAssetId: マスタ外の銘柄・非文字列を拒否', () => {
    expect(validateAssetId('bitcoin')).toBe('bitcoin')
    expect(() => validateAssetId('__proto__')).toThrowError()
    expect(() => validateAssetId('unknown-coin')).toThrowError()
    expect(() => validateAssetId(123)).toThrowError()
  })

  it('validateHorizon: 3値以外を拒否', () => {
    expect(validateHorizon('short')).toBe('short')
    expect(() => validateHorizon('forever')).toThrowError()
  })

  it('validateTicker: モックティッカーは全銘柄通過する', () => {
    for (const t of mockTickers()) {
      const validated = validateTicker(t)
      expect(validated.assetId).toBe(t.assetId)
      expect(validated.sparkline7d).toHaveLength(t.sparkline7d.length)
    }
  })

  it('validateTicker: NaN・負値・過大な配列を拒否', () => {
    const base = mockTickers()[0]
    expect(() => validateTicker({ ...base, priceUsd: Number.NaN })).toThrowError()
    expect(() => validateTicker({ ...base, priceUsd: -1 })).toThrowError()
    expect(() => validateTicker({ ...base, sparkline7d: Array(501).fill(1) })).toThrowError()
    expect(() => validateTicker(null)).toThrowError()
  })

  it('validateStrategy: サイズ上限で拒否（プロンプト注入対策）', () => {
    const ok = validateStrategy({ name: 'test', content: 'ルール', riskLevel: 3 })
    expect(ok?.name).toBe('test')
    expect(() => validateStrategy({ name: 'x'.repeat(101), content: 'a' })).toThrowError()
    expect(() => validateStrategy({ name: 'a', content: 'x'.repeat(4001) })).toThrowError()
    expect(validateStrategy(undefined)).toBeUndefined()
  })

  it('エラーは HTTP 400 として送出される', () => {
    try {
      validateHorizon('bad')
      expect.unreachable()
    } catch (err) {
      expect((err as { statusCode?: number }).statusCode).toBe(400)
      expect(String((err as Error & { statusMessage?: string }).statusMessage)).toContain('CRYPTIA-E301')
    }
  })
})

import { describe, expect, it } from 'vitest'
import { retrieveStrategies, STRATEGY_PRESETS } from '~/shared/strategyPresets'

describe('RAG 戦略プリセット（shared/strategyPresets）', () => {
  it('デフォルト戦術が5種類以上定義され、すべて builtin', () => {
    expect(STRATEGY_PRESETS.length).toBeGreaterThanOrEqual(5)
    expect(STRATEGY_PRESETS.every((d) => d.builtin)).toBe(true)
    expect(STRATEGY_PRESETS.every((d) => d.content.length > 0)).toBe(true)
  })

  it('id はユニーク', () => {
    const ids = STRATEGY_PRESETS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('retrieveStrategies: キーワードで関連戦略を検索する（キーワード RAG）', () => {
    const hit = retrieveStrategies(STRATEGY_PRESETS, 'solana 草コイン ラダー')
    expect(hit.length).toBeGreaterThan(0)
    expect(hit[0].id).toBe('preset-degen-ladder')
  })

  it('retrieveStrategies: 一致なしは空配列', () => {
    expect(retrieveStrategies(STRATEGY_PRESETS, 'zzzzz xxxxx')).toHaveLength(0)
  })

  it('retrieveStrategies: 空クエリは先頭から limit 件', () => {
    expect(retrieveStrategies(STRATEGY_PRESETS, '', 2)).toHaveLength(2)
  })
})

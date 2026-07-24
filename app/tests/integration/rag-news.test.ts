import { describe, expect, it } from 'vitest'
import { filterNewsForAsset } from '~/server/utils/news'
import { retrieveRelevantStrategies } from '~/server/utils/rag'
import { ASSET_MAP } from '~/shared/assets'
import { STRATEGY_PRESETS } from '~/shared/strategyPresets'
import type { NewsItem } from '~/shared/types'

/**
 * 結合テスト: RAG 検索（Vertex 未設定 → キーワードフォールバック）とニュースフィルタ。
 */
describe('RAG 検索結合', () => {
  it('Vertex 未設定環境ではキーワード検索へフォールバックする', async () => {
    const result = await retrieveRelevantStrategies(STRATEGY_PRESETS, 'solana 草コイン ラダー 損切り')
    expect(result.method).toBe('keyword')
    expect(result.docs.length).toBeGreaterThan(0)
    expect(result.docs[0].id).toBe('preset-degen-ladder')
  })

  it('excludeId のドキュメントは検索結果から除外される', async () => {
    const result = await retrieveRelevantStrategies(STRATEGY_PRESETS, 'solana 草コイン ラダー', {
      excludeId: 'preset-degen-ladder',
    })
    expect(result.docs.every((d) => d.id !== 'preset-degen-ladder')).toBe(true)
  })

  it('候補が空なら空配列', async () => {
    const result = await retrieveRelevantStrategies([], 'query')
    expect(result.docs).toHaveLength(0)
  })
})

describe('ニュースの銘柄関連フィルタ', () => {
  const items: NewsItem[] = [
    { title: 'Market update: stocks rally', url: '', source: 'S', publishedAt: 3 },
    { title: 'Bitcoin hits new high as ETF inflows surge', url: '', source: 'S', publishedAt: 2 },
    { title: 'ビットコイン、11万ドルを突破', url: '', source: 'S', publishedAt: 1 },
  ]

  it('シンボル・和名にマッチする見出しが先頭へ来る', () => {
    const btc = ASSET_MAP.bitcoin
    const filtered = filterNewsForAsset(items, btc)
    expect(filtered[0].title).toContain('Bitcoin')
    expect(filtered[1].title).toContain('ビットコイン')
    expect(filtered[2].title).toContain('stocks')
  })

  it('asset 未指定はそのまま返す', () => {
    expect(filterNewsForAsset(items, undefined)).toEqual(items)
  })
})

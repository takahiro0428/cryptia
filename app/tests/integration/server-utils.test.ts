import { describe, expect, it } from 'vitest'
import { parseRssItems } from '~/server/utils/news'
import { parseJsonResponse } from '~/server/utils/vertex'

/**
 * 結合テスト: サーバーユーティリティ（ニュース RSS パース・AI 応答パース）。
 */
describe('サーバーユーティリティ結合', () => {
  it('parseRssItems: CDATA 付き RSS をパースする', () => {
    const xml = `<?xml version="1.0"?><rss><channel>
      <item><title><![CDATA[Bitcoin surges past $120K]]></title><link>https://example.com/1</link><pubDate>Wed, 23 Jul 2026 10:00:00 GMT</pubDate></item>
      <item><title>Plain title</title><link>https://example.com/2</link></item>
    </channel></rss>`
    const items = parseRssItems(xml, 'TestSource')
    expect(items).toHaveLength(2)
    expect(items[0].title).toBe('Bitcoin surges past $120K')
    expect(items[0].source).toBe('TestSource')
    expect(items[0].publishedAt).toBeGreaterThan(0)
    expect(items[1].title).toBe('Plain title')
  })

  it('parseRssItems: 空・壊れた XML は空配列', () => {
    expect(parseRssItems('', 'S')).toHaveLength(0)
    expect(parseRssItems('<rss><channel></channel></rss>', 'S')).toHaveLength(0)
  })

  it('parseRssItems: limit 件で打ち切る', () => {
    const xml = Array.from(
      { length: 30 },
      (_, i) => `<item><title>t${i}</title><link>u${i}</link></item>`,
    ).join('')
    expect(parseRssItems(xml, 'S', 5)).toHaveLength(5)
  })

  it('parseJsonResponse: コードフェンス付き JSON を解析する', () => {
    const parsed = parseJsonResponse<{ a: number }>('```json\n{"a": 1}\n```')
    expect(parsed).toEqual({ a: 1 })
    expect(parseJsonResponse('{"b":2}')).toEqual({ b: 2 })
  })

  it('parseJsonResponse: 不正 JSON・null は null（フォールバック経路へ）', () => {
    expect(parseJsonResponse('not json')).toBeNull()
    expect(parseJsonResponse(null)).toBeNull()
  })
})

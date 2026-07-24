import { ERROR_CODES } from '~/shared/errors'
import type { NewsItem } from '~/shared/types'

/**
 * ニュース/市場コンテキスト収集（F-10）。
 * AI の判断材料として公開 RSS・トレンド API から取得する。
 * 全ソース失敗時は空配列を返し、AI はテクニカルのみで判断を継続する（BR-5）。
 */

const CACHE_TTL_MS = 5 * 60 * 1000
let cache: { items: NewsItem[]; fetchedAt: number } = { items: [], fetchedAt: 0 }

/** RSS 2.0 の <item> を最小限パースする（外部 XML パーサ依存を避ける） */
export function parseRssItems(xml: string, source: string, limit = 10): NewsItem[] {
  const items: NewsItem[] = []
  const itemBlocks = xml.match(/<item[\s\S]*?<\/item>/g) ?? []
  for (const block of itemBlocks.slice(0, limit)) {
    const pick = (tag: string) => {
      const m =
        block.match(new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`)) ??
        block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))
      return m?.[1]?.trim() ?? ''
    }
    const title = pick('title')
    const link = pick('link')
    const pubDate = pick('pubDate')
    if (!title) continue
    items.push({
      title,
      url: link,
      source,
      publishedAt: pubDate ? Date.parse(pubDate) || Date.now() : Date.now(),
    })
  }
  return items
}

async function fetchWithTimeout(url: string, timeoutMs = 6000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

async function fetchRss(url: string, source: string): Promise<NewsItem[]> {
  try {
    const res = await fetchWithTimeout(url)
    if (!res.ok) return []
    return parseRssItems(await res.text(), source)
  } catch (err) {
    console.warn(
      `[${ERROR_CODES.NEWS_FETCH_FAILED}] ${source} 取得失敗: ${err instanceof Error ? err.message : err}`,
    )
    return []
  }
}

async function fetchCoinGeckoTrending(): Promise<NewsItem[]> {
  try {
    const res = await fetchWithTimeout('https://api.coingecko.com/api/v3/search/trending')
    if (!res.ok) return []
    const data = (await res.json()) as { coins?: { item?: { name?: string; symbol?: string } }[] }
    const names = (data.coins ?? [])
      .map((c) => `${c.item?.name ?? ''}(${c.item?.symbol ?? ''})`)
      .filter((s) => s !== '()')
      .slice(0, 7)
    if (names.length === 0) return []
    return [
      {
        title: `CoinGecko 検索トレンド上位: ${names.join(', ')}`,
        url: 'https://www.coingecko.com/',
        source: 'CoinGecko Trending',
        publishedAt: Date.now(),
      },
    ]
  } catch {
    return []
  }
}

/** ニュースを取得（5分キャッシュ）。全ソース並行取得・部分失敗許容 */
export async function getMarketNews(): Promise<NewsItem[]> {
  if (Date.now() - cache.fetchedAt < CACHE_TTL_MS && cache.items.length > 0) {
    return cache.items
  }
  const results = await Promise.allSettled([
    fetchRss('https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'),
    fetchRss('https://cointelegraph.com/rss', 'Cointelegraph'),
    fetchCoinGeckoTrending(),
  ])
  const items = results
    .filter((r): r is PromiseFulfilledResult<NewsItem[]> => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, 15)
  if (items.length > 0) {
    cache = { items, fetchedAt: Date.now() }
  }
  return items
}

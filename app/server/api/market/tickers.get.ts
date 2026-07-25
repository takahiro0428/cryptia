import { defineEventHandler } from 'h3'
import { ASSETS } from '~/shared/assets'
import { cachedProxyJson, fetchUpstreamJson } from '../../utils/dexProxy'

const COINGECKO_URL = 'https://api.coingecko.com/api/v3/coins/markets'
/** キャッシュ有効期間（CoinGecko 無料枠保護を優先し、クライアントの最終キャッシュ表示を許容） */
const TTL_MS = 30_000

/**
 * CoinGecko 価格取得のプロキシ（GET /api/market/tickers）。
 * ブラウザから api.coingecko.com へ到達できない環境（企業ネットワーク・
 * 広告ブロッカー等）向けのフォールバック。対象銘柄はサーバー側の
 * 銘柄マスタで固定し、任意 URL の中継はしない。
 */
export default defineEventHandler(async (event) => {
  return cachedProxyJson(event, { key: 'tickers', ttlMs: TTL_MS, upstream: 'coingecko' }, () => {
    const ids = ASSETS.map((a) => a.id).join(',')
    const url = `${COINGECKO_URL}?vs_currency=usd&ids=${ids}&sparkline=true&price_change_percentage=1h,24h,7d&per_page=${ASSETS.length}`
    return fetchUpstreamJson<unknown[]>(url)
  })
})

import { defineEventHandler } from 'h3'
import { DEX_SEARCH_URL, type DexPair } from '~/shared/dexscreener'
import { cachedProxyJson, fetchUpstreamJson } from '../../utils/dexProxy'

/** スクリーニングリストのキャッシュ有効期間（ティック 30s より短く保つ） */
const TTL_MS = 20_000

/**
 * DexScreener スクリーニングのプロキシ（GET /api/solana/screen）。
 * ブラウザから直接取得できない環境向けフォールバック。Solana ペアのみ返す。
 */
export default defineEventHandler(async (event) => {
  return cachedProxyJson(event, { key: 'screen', ttlMs: TTL_MS, upstream: 'dexscreener' }, async () => {
    const data = await fetchUpstreamJson<{ pairs?: DexPair[] }>(DEX_SEARCH_URL)
    const pairs = (data.pairs ?? []).filter((p) => p.chainId === 'solana')
    return { pairs }
  })
})

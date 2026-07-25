import { createError, defineEventHandler } from 'h3'
import { discoverScreeningPairs } from '~/shared/dexscreener'
import { ERROR_CODES } from '~/shared/errors'
import { cachedProxyJson, fetchUpstreamJson } from '../../utils/dexProxy'

/** スクリーニングリストのキャッシュ有効期間（ティック 30s より短く保つ） */
const TTL_MS = 20_000
/** 多ソース収集の上流呼び出し見積り（search 1 + boosts 1 + profiles 1 + tokens バッチ 2） */
const UPSTREAM_COST = 5
/**
 * 収集全体のデッドライン。超過後の追加フェッチを打ち切り、クライアントの
 * タイムアウト（25s）内に必ず応答する（AUDIT-P9-5 と同パターン。
 * 最悪 = デッドライン到達直前に開始した 1 フェッチ 9s を加えて約 21s）
 */
const DEADLINE_MS = 12_000

/**
 * DexScreener スクリーニングのプロキシ（GET /api/solana/screen）。
 * ブラウザから直接取得できない環境向けフォールバック。
 * search 単独では Solana ペアが空になる事象が本番で確認されたため、
 * boosts / profiles を含む多ソース収集（shared/dexscreener.ts）で返す。
 */
export default defineEventHandler(async (event) => {
  return cachedProxyJson(
    event,
    { key: 'screen', ttlMs: TTL_MS, upstream: 'dexscreener', upstreamCost: UPSTREAM_COST },
    async () => {
      const startedAt = Date.now()
      const pairs = await discoverScreeningPairs(<T>(url: string): Promise<T> => {
        if (Date.now() - startedAt > DEADLINE_MS) {
          return Promise.reject(new Error('screen deadline exceeded'))
        }
        return fetchUpstreamJson<T>(url)
      })
      if (pairs.length === 0) {
        // 3 ソースすべて空 = 上流障害とみなす。空リストをキャッシュせず、
        // stale があれば cachedProxyJson 側で劣化継続される
        throw createError({
          statusCode: 502,
          statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: 全ソースから Solana ペアを取得できませんでした`,
        })
      }
      return { pairs }
    },
  )
})

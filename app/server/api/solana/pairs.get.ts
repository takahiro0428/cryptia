import { createError, defineEventHandler, getQuery } from 'h3'
import { DEX_PAIRS_URL, isValidAddress, type DexPair } from '~/shared/dexscreener'
import { ERROR_CODES } from '~/shared/errors'
import { cachedProxyJson, fetchUpstreamJson } from '../../utils/dexProxy'

/** ペア個別価格のキャッシュ有効期間（表示更新 10s より短く保つ） */
const TTL_MS = 8_000
const MAX_ADDRS = 30

/**
 * DexScreener ペア個別取得のプロキシ（GET /api/solana/pairs?addrs=a,b,c）。
 * 保有ポジションの価格更新（リアルタイム損益表示）に使用する。
 */
export default defineEventHandler(async (event) => {
  const raw = String(getQuery(event).addrs ?? '')
  const addrs = raw.split(',').map((s) => s.trim()).filter(Boolean)
  if (addrs.length === 0 || addrs.length > MAX_ADDRS || !addrs.every(isValidAddress)) {
    throw createError({
      statusCode: 400,
      statusMessage: `${ERROR_CODES.INVALID_INPUT}: addrs が不正です（1〜${MAX_ADDRS} 件のペアアドレス）`,
    })
  }
  // キャッシュキーはソートして順序ゆらぎを吸収する
  const key = `pairs:${[...addrs].sort().join(',')}`
  return cachedProxyJson(event, { key, ttlMs: TTL_MS, upstream: 'dexscreener' }, async () => {
    const data = await fetchUpstreamJson<{ pairs?: DexPair[] }>(`${DEX_PAIRS_URL}${addrs.join(',')}`)
    return { pairs: (data.pairs ?? []).filter((p) => p.chainId === 'solana') }
  })
})

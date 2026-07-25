import { createError, defineEventHandler, readBody } from 'h3'
import { isValidAddress } from '~/shared/dexscreener'
import { ERROR_CODES } from '~/shared/errors'
import { consumeProxyQuota, consumeUpstreamBudget } from '../../utils/dexProxy'

const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'
const RPC_TIMEOUT_MS = 9_000

/**
 * 読み取り専用の許可メソッド（オープンプロキシ化の防止）。
 * 残高表示に必要な最小セットのみ中継する。署名・送信系（sendTransaction 等）は
 * 一切許可しない（Tx 送信はウォレット側で完結する設計: BR-1）
 */
const ALLOWED_METHODS = new Set(['getBalance', 'getTokenAccountsByOwner'])

/**
 * Solana RPC の読み取り専用プロキシ（POST /api/solana/rpc）。
 * 公開 RPC（mainnet-beta）はブラウザ発のリクエストをレートリミット/遮断することが多く、
 * 残高が「取得中」のまま固まる本番障害の原因になった。サーバー経由の
 * フォールバック経路として、宛先固定・メソッド許可制で中継する。
 */
export default defineEventHandler(async (event) => {
  consumeProxyQuota(event)
  if (!consumeUpstreamBudget('rpc')) {
    throw createError({
      statusCode: 503,
      statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: 上流 RPC 保護のため一時的に制限しています。しばらく待って再試行してください`,
    })
  }
  const body = (await readBody(event)) as {
    jsonrpc?: string
    id?: number
    method?: string
    params?: unknown[]
  } | null
  if (
    !body ||
    typeof body.method !== 'string' ||
    !ALLOWED_METHODS.has(body.method) ||
    !Array.isArray(body.params) ||
    body.params.length === 0 ||
    body.params.length > 3 ||
    typeof body.params[0] !== 'string' ||
    !isValidAddress(body.params[0])
  ) {
    throw createError({
      statusCode: 400,
      statusMessage: `${ERROR_CODES.INVALID_INPUT}: 許可されていない RPC リクエストです`,
    })
  }

  let res: Response
  try {
    res = await fetch(SOLANA_RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: typeof body.id === 'number' ? body.id : 1,
        method: body.method,
        params: body.params,
      }),
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
    })
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: Solana RPC に接続できません（${err instanceof Error ? err.name : 'error'}）`,
    })
  }
  if (!res.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: Solana RPC がエラーを返しました（HTTP ${res.status}）`,
    })
  }
  return await res.json()
})

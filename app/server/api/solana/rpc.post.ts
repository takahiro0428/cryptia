import { createError, defineEventHandler, readBody } from 'h3'
import { isValidAddress } from '~/shared/dexscreener'
import { ERROR_CODES } from '~/shared/errors'
import { consumeProxyQuota, consumeUpstreamBudget } from '../../utils/dexProxy'

const SOLANA_RPC_URL = 'https://api.mainnet-beta.solana.com'
const RPC_TIMEOUT_MS = 9_000

/**
 * 許可メソッドとメソッド別のパラメータ検証（オープンプロキシ化の防止）。
 * - 読み取り系: 残高表示に必要な最小セット（第1引数 = アドレス必須）
 * - 送信系: **署名済み** Tx の中継（sendTransaction）と、その前提となる
 *   blockhash / 確認状況の取得のみ。プロキシは署名能力を持たず、署名は
 *   端末内（ウォレット or 暗号化ボットウォレット）で完結する（BR-1 改訂:
 *   F-13 ボットウォレット自動実行のための追加。未署名 Tx は RPC 側で拒否される）
 */
const TX_BASE64_MAX = 3_000 // Solana Tx 上限 1232 バイト → base64 で約 1644 文字 + 余裕
const SIGNATURE_RE = /^[1-9A-HJ-NP-Za-km-z]{64,96}$/
const COMMITMENTS = new Set(['processed', 'confirmed', 'finalized'])
/** オプションオブジェクトの検証（許可キーのみ・値域つき。未知キーは拒否） */
function validOptions(v: unknown, allowed: Record<string, (x: unknown) => boolean>): boolean {
  if (v === undefined) return true
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.entries(v as Record<string, unknown>).every(
    ([k, x]) => Object.hasOwn(allowed, k) && allowed[k](x),
  )
}
// プロトタイプ汚染由来のバイパス防止のため null プロトタイプで定義（'constructor' 等が
// 継承解決されて許可リストを通過しない: ISSUE-P9-L36 系）
export const METHOD_VALIDATORS: Record<string, (params: unknown[]) => boolean> = Object.assign(
  Object.create(null) as Record<string, (params: unknown[]) => boolean>,
  {
    getBalance: (p: unknown[]) => typeof p[0] === 'string' && isValidAddress(p[0]) && p.length <= 3,
    getTokenAccountsByOwner: (p: unknown[]) =>
      typeof p[0] === 'string' && isValidAddress(p[0]) && p.length <= 3,
    sendTransaction: (p: unknown[]) =>
      typeof p[0] === 'string' &&
      p[0].length > 0 &&
      p[0].length <= TX_BASE64_MAX &&
      /^[A-Za-z0-9+/=]+$/.test(p[0]) &&
      p.length <= 2 &&
      validOptions(p[1], {
        encoding: (x) => x === 'base64',
        maxRetries: (x) => Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 5,
        // preflight（署名・残高検証）の無効化は許可しない（未署名 Tx 中継の防止を preflight に依存）
        skipPreflight: (x) => x === false,
      }),
    getLatestBlockhash: (p: unknown[]) =>
      p.length <= 1 && validOptions(p[0], { commitment: (x) => typeof x === 'string' && COMMITMENTS.has(x) }),
    getSignatureStatuses: (p: unknown[]) =>
      Array.isArray(p[0]) &&
      p[0].length >= 1 &&
      p[0].length <= 10 &&
      p[0].every((s) => typeof s === 'string' && SIGNATURE_RE.test(s)) &&
      p.length <= 2 &&
      validOptions(p[1], { searchTransactionHistory: (x) => typeof x === 'boolean' }),
  },
)

/**
 * Solana RPC の許可制プロキシ（POST /api/solana/rpc。読み取り + 署名済み Tx の中継）。
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
  const validator = body && typeof body.method === 'string' ? METHOD_VALIDATORS[body.method] : undefined
  if (!body || !validator || !Array.isArray(body.params) || !validator(body.params)) {
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

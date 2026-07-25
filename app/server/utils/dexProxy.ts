import { createError, getRequestHeader, type H3Event } from 'h3'
import { ERROR_CODES } from '~/shared/errors'
import { clientIpFromForwarded, consumeToken, consumeTokens } from './rateLimit'

/**
 * 外部データプロキシ共通処理（/api/market/tickers, /api/solana/*）。
 * ブラウザから外部 API へ到達できない環境（企業ネットワーク・広告ブロッカー等）向けの
 * フォールバック経路。多層防御で上流とインフラを保護する:
 *   1. クライアント IP 単位のレートリミット（キャッシュミス時のみ消費 — 企業 NAT で
 *      複数ユーザーが同一 IP を共有してもキャッシュヒットは無償: AUDIT-P9-2）
 *   2. 上流ホスト単位の総量バジェット（分散 IP からの合計でも上流レートリミット・
 *      無料枠を超えない: AUDIT-P9-3）
 *   3. 短期 TTL キャッシュ + 同一キーの inflight 合流。上流障害・バジェット超過時は
 *      期限切れキャッシュを stale として返す（stale-while-error）
 */

/** クライアント IP 単位・毎分上限（キャッシュミス時のみ消費） */
const PROXY_RATE_LIMIT = 60
/** 上流フェッチのタイムアウト */
const UPSTREAM_TIMEOUT_MS = 9_000

/**
 * 上流ホスト単位・毎分の呼び出しバジェット（インスタンス単位）。
 * maxInstances: 3 で分散するため、実効上限は約 3 倍になる前提で
 * 上流規約より十分低く設定する（DexScreener 約300/分・CoinGecko 無料枠 約5-15/分）。
 */
const UPSTREAM_BUDGETS = {
  dexscreener: 60,
  coingecko: 4,
  rpc: 30,
} as const

export type UpstreamHost = keyof typeof UPSTREAM_BUDGETS

interface CacheEntry {
  at: number
  data: unknown
}

const cache = new Map<string, CacheEntry>()
const MAX_CACHE_ENTRIES = 200
const inflight = new Map<string, Promise<unknown>>()

/** ai-rate-limit ミドルウェアと同一実装で信頼できるクライアント IP を得る（原則3） */
function proxyClientIp(event: H3Event): string {
  return clientIpFromForwarded(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket?.remoteAddress,
  )
}

/** プロキシ利用のレートリミット消費。超過時は 429 */
export function consumeProxyQuota(event: H3Event): void {
  const ip = proxyClientIp(event)
  if (!consumeToken(`dex:${ip}`, Date.now(), PROXY_RATE_LIMIT)) {
    throw createError({
      statusCode: 429,
      statusMessage: `${ERROR_CODES.RATE_LIMITED}: リクエストが多すぎます。しばらく待って再試行してください`,
    })
  }
}

/**
 * 上流ホストの呼び出しバジェットを消費する。cost は 1 リクエストで発生する
 * 上流呼び出し回数の見積り（例: fresh パイプラインは最大 12 回）。
 * all-or-nothing で判定し、部分消費で他リクエストの枠を圧迫しない。
 */
export function consumeUpstreamBudget(host: UpstreamHost, cost = 1): boolean {
  return consumeTokens(`up:${host}`, Date.now(), UPSTREAM_BUDGETS[host], cost)
}

/** タイムアウト付き JSON フェッチ。失敗は E102 付き 502 に正規化する */
export async function fetchUpstreamJson<T>(url: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch (err) {
    throw createError({
      statusCode: 502,
      statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: 上流 API に接続できません（${err instanceof Error ? err.name : 'error'}）`,
    })
  }
  if (!res.ok) {
    throw createError({
      statusCode: 502,
      statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: 上流 API がエラーを返しました（HTTP ${res.status}）`,
    })
  }
  return (await res.json()) as T
}

/**
 * プロキシ GET ルートの共通フロー:
 * キャッシュヒット（TTL 内）→ そのまま返す（クォータ消費なし）
 * ミス → IP クォータ + 上流バジェットを消費してビルド
 * 上流バジェット超過・ビルド失敗 → 期限切れキャッシュがあれば stale で返す
 */
export async function cachedProxyJson<T>(
  event: H3Event,
  opts: { key: string; ttlMs: number; upstream: UpstreamHost; upstreamCost?: number },
  build: () => Promise<T>,
): Promise<T> {
  const hit = cache.get(opts.key)
  if (hit && Date.now() - hit.at < opts.ttlMs) return hit.data as T

  const running = inflight.get(opts.key)
  if (running) return (await running) as T

  // ミス時のみクォータを消費する（キャッシュヒットは上流コストゼロのため）
  consumeProxyQuota(event)
  if (!consumeUpstreamBudget(opts.upstream, opts.upstreamCost ?? 1)) {
    // 上流保護を優先し、期限切れでも手元のデータを返す（BR-5: 劣化継続）
    if (hit) return hit.data as T
    throw createError({
      statusCode: 503,
      statusMessage: `${ERROR_CODES.DEX_FETCH_FAILED}: 上流 API 保護のため一時的に制限しています。しばらく待って再試行してください`,
    })
  }

  const promise = build()
    .then((data) => {
      if (!cache.has(opts.key) && cache.size >= MAX_CACHE_ENTRIES) {
        // 最終更新が最も古いエントリを間引く（挿入順基準だと、更新を繰り返す
        // ホットな共有キーが誤って追い出され stale 劣化継続が効かなくなる）
        let oldestKey: string | undefined
        let oldestAt = Infinity
        for (const [k, v] of cache) {
          if (v.at < oldestAt) {
            oldestAt = v.at
            oldestKey = k
          }
        }
        if (oldestKey !== undefined) cache.delete(oldestKey)
      }
      cache.set(opts.key, { at: Date.now(), data })
      return data
    })
    .finally(() => inflight.delete(opts.key))
  inflight.set(opts.key, promise)
  try {
    return (await promise) as T
  } catch (err) {
    // ビルド失敗時も stale があれば劣化継続（原則4）
    if (hit) return hit.data as T
    throw err
  }
}

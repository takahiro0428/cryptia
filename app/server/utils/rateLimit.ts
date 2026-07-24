import { ERROR_CODES } from '~/shared/errors'

/**
 * AI API 用の簡易レートリミッタ（AUDIT-2 対策）。
 * IP 単位の固定ウィンドウ方式。インメモリのため単一インスタンス内でのみ有効だが、
 * Cloud Functions の同時実行数上限（maxInstances: 3）と合わせて
 * 匿名からの LLM プロキシ濫用・課金踏み台化の実効的な抑止として機能する。
 * 本番強化（Firebase App Check / 認証必須化）は Phase 8 の残課題として記録済み。
 */

export const RATE_LIMIT_MAX = 20
export const RATE_LIMIT_WINDOW_MS = 60_000

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

/** 上限内なら消費して true、超過なら false を返す。 */
export function consumeToken(key: string, now = Date.now()): boolean {
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    buckets.set(key, { count: 1, windowStart: now })
    return true
  }
  if (bucket.count >= RATE_LIMIT_MAX) return false
  bucket.count++
  return true
}

/** 期限切れバケットの掃除（メモリリーク防止）。呼び出しは低頻度でよい */
export function pruneBuckets(now = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS * 2) buckets.delete(key)
  }
}

export const RATE_LIMIT_ERROR = ERROR_CODES.RATE_LIMITED

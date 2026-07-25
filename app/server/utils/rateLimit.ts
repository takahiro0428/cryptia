import { ERROR_CODES } from '~/shared/errors'

/**
 * AI API 用の簡易レートリミッタ（AUDIT-2 対策）。
 * IP 単位の固定ウィンドウ方式。インメモリのため単一インスタンス内でのみ有効だが、
 * Cloud Functions の同時実行数上限（maxInstances: 3）と合わせて
 * 匿名からの LLM プロキシ濫用・課金踏み台化の実効的な抑止として機能する。
 * 本番強化（Firebase App Check / 認証必須化）は Phase 8 の残課題として記録済み。
 */

/** 匿名（IP キー）の毎分上限 */
export const RATE_LIMIT_MAX = 20
/** 認証済み（uid キー）の毎分上限（正規ユーザーを優遇） */
export const RATE_LIMIT_MAX_AUTHED = 40
export const RATE_LIMIT_WINDOW_MS = 60_000

interface Bucket {
  count: number
  windowStart: number
}

const buckets = new Map<string, Bucket>()

/** バケット数の上限（キー偽装によるメモリ増加ベクタの抑止: AUDIT-10） */
export const MAX_BUCKETS = 10_000

/** 上限内なら消費して true、超過なら false を返す。 */
export function consumeToken(key: string, now = Date.now(), max = RATE_LIMIT_MAX): boolean {
  return consumeTokens(key, now, max, 1)
}

/**
 * cost 分を一括消費する（all-or-nothing）。残量不足時は一切消費せず false を返す
 * （部分消費が残ると他リクエストの正規枠を不当に圧迫するため）。
 */
export function consumeTokens(key: string, now: number, max: number, cost: number): boolean {
  if (cost > max) return false
  const bucket = buckets.get(key)
  if (!bucket || now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS) {
    if (!bucket && buckets.size >= MAX_BUCKETS) {
      // まず期限切れを掃除し、それでも満杯なら新規キーを拒否する
      // （フェイルクローズ: メモリ枯渇より正規ユーザーの一時 429 を優先）
      pruneBuckets(now)
      if (buckets.size >= MAX_BUCKETS) return false
    }
    buckets.set(key, { count: cost, windowStart: now })
    return true
  }
  if (bucket.count + cost > max) return false
  bucket.count += cost
  return true
}

/** 期限切れバケットの掃除（メモリリーク防止）。呼び出しは低頻度でよい */
export function pruneBuckets(now = Date.now()): void {
  for (const [key, bucket] of buckets) {
    if (now - bucket.windowStart >= RATE_LIMIT_WINDOW_MS * 2) buckets.delete(key)
  }
}

/**
 * X-Forwarded-For から信頼できるクライアント IP を取り出す（AUDIT-10）。
 * XFF の左側はクライアントが任意に偽装できるため使用しない。信頼できるのは
 * インフラ（GFE / Hosting CDN）が接続元を末尾に追記した右側のみ。
 * 経由ホップ数は環境変数 NUXT_TRUSTED_PROXY_HOPS（既定 1 = 右端）で調整する。
 * レートリミットを使う全エンドポイントで本実装を共有する（原則3・実装ドリフト防止）。
 */
export function clientIpFromForwarded(
  forwarded: string | undefined,
  socketAddr: string | undefined,
): string {
  if (!forwarded) return socketAddr || 'unknown'
  const entries = forwarded.split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) return socketAddr || 'unknown'
  const hops = Math.max(1, Number(process.env.NUXT_TRUSTED_PROXY_HOPS) || 1)
  return entries[Math.max(0, entries.length - hops)]
}

export const RATE_LIMIT_ERROR = ERROR_CODES.RATE_LIMITED

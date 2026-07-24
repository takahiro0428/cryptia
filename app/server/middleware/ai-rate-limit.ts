import { createError, defineEventHandler, getRequestHeader } from 'h3'
import { consumeToken, pruneBuckets, RATE_LIMIT_ERROR } from '../utils/rateLimit'

let requestCount = 0

/**
 * X-Forwarded-For から信頼できるクライアント IP を取り出す（AUDIT-10）。
 * XFF の左側はクライアントが任意に偽装できるため使用しない。信頼できるのは
 * インフラ（GFE / Hosting CDN）が接続元を末尾に追記した右側のみ。
 * 経由ホップ数は環境変数 NUXT_TRUSTED_PROXY_HOPS（既定 1 = 右端）で調整する
 * （Firebase Hosting 経由で CDN ホップが加わる構成では 2 に設定する）。
 */
function clientIp(forwarded: string | undefined, socketAddr: string | undefined): string {
  if (!forwarded) return socketAddr || 'unknown'
  const entries = forwarded.split(',').map((s) => s.trim()).filter(Boolean)
  if (entries.length === 0) return socketAddr || 'unknown'
  const hops = Math.max(1, Number(process.env.NUXT_TRUSTED_PROXY_HOPS) || 1)
  return entries[Math.max(0, entries.length - hops)]
}

/**
 * /api/ai/* へのレートリミット（IP 単位・毎分 20 リクエスト）。
 * 認証なし公開 API が Vertex AI への無料プロキシとして濫用されるのを防ぐ（AUDIT-2）。
 */
export default defineEventHandler((event) => {
  const path = event.path ?? ''
  if (!path.startsWith('/api/ai/')) return

  const ip = clientIp(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket?.remoteAddress,
  )

  if (!consumeToken(ip)) {
    throw createError({
      statusCode: 429,
      statusMessage: `${RATE_LIMIT_ERROR}: リクエストが多すぎます。しばらく待って再試行してください`,
    })
  }

  // 100 リクエストごとに期限切れバケットを掃除
  if (++requestCount % 100 === 0) pruneBuckets()
})

import { createError, defineEventHandler, getRequestHeader } from 'h3'
import { consumeToken, pruneBuckets, RATE_LIMIT_ERROR } from '../utils/rateLimit'

let requestCount = 0

/**
 * /api/ai/* へのレートリミット（IP 単位・毎分 20 リクエスト）。
 * 認証なし公開 API が Vertex AI への無料プロキシとして濫用されるのを防ぐ（AUDIT-2）。
 */
export default defineEventHandler((event) => {
  const path = event.path ?? ''
  if (!path.startsWith('/api/ai/')) return

  // Firebase Hosting / LB 経由の実クライアント IP（先頭が発信元）
  const forwarded = getRequestHeader(event, 'x-forwarded-for')
  const ip =
    forwarded?.split(',')[0]?.trim() || event.node.req.socket?.remoteAddress || 'unknown'

  if (!consumeToken(ip)) {
    throw createError({
      statusCode: 429,
      statusMessage: `${RATE_LIMIT_ERROR}: リクエストが多すぎます。しばらく待って再試行してください`,
    })
  }

  // 100 リクエストごとに期限切れバケットを掃除
  if (++requestCount % 100 === 0) pruneBuckets()
})

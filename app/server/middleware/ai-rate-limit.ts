import { createError, defineEventHandler, getRequestHeader } from 'h3'
import { verifyFirebaseIdToken } from '../utils/firebaseAuth'
import {
  consumeToken,
  pruneBuckets,
  RATE_LIMIT_ERROR,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_AUTHED,
} from '../utils/rateLimit'

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
 * /api/ai/* のレートリミット + 段階的認証（AUDIT-2 / Phase 8 本格化）。
 * - Firebase ID トークン（Authorization: Bearer）を検証できた場合: uid 単位・毎分 40
 * - 匿名: 信頼 IP 単位・毎分 20
 * - NUXT_AI_REQUIRE_AUTH=true の環境では未認証リクエストを 401 で拒否
 *   （Firebase 未設定のローカル/デモ環境は既定の匿名許可のまま動作する）
 */
export default defineEventHandler(async (event) => {
  const path = event.path ?? ''
  if (!path.startsWith('/api/ai/')) return

  const config = useRuntimeConfig()
  const projectId = (config.gcpProjectId || config.public.firebaseProjectId || '') as string
  const uid = await verifyFirebaseIdToken(getRequestHeader(event, 'authorization'), projectId)

  if (!uid && process.env.NUXT_AI_REQUIRE_AUTH === 'true') {
    throw createError({
      statusCode: 401,
      statusMessage: 'CRYPTIA-E303: AI 機能の利用にはサインイン（匿名認証）が必要です',
    })
  }

  const key = uid
    ? `uid:${uid}`
    : `ip:${clientIp(getRequestHeader(event, 'x-forwarded-for'), event.node.req.socket?.remoteAddress)}`

  if (!consumeToken(key, Date.now(), uid ? RATE_LIMIT_MAX_AUTHED : RATE_LIMIT_MAX)) {
    throw createError({
      statusCode: 429,
      statusMessage: `${RATE_LIMIT_ERROR}: リクエストが多すぎます。しばらく待って再試行してください`,
    })
  }

  // 100 リクエストごとに期限切れバケットを掃除
  if (++requestCount % 100 === 0) pruneBuckets()
})

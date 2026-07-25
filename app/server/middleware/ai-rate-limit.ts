import { createError, defineEventHandler, getRequestHeader } from 'h3'
import { ERROR_CODES } from '~/shared/errors'
import { verifyFirebaseIdToken } from '../utils/firebaseAuth'
import {
  clientIpFromForwarded,
  consumeToken,
  pruneBuckets,
  RATE_LIMIT_ERROR,
  RATE_LIMIT_MAX,
  RATE_LIMIT_MAX_AUTHED,
} from '../utils/rateLimit'

/** 認証済みでも適用する IP 単位のバックストップ上限（uid 使い捨てによる回避防止: ISSUE-P8-5） */
const RATE_LIMIT_MAX_IP_BACKSTOP = 60

let requestCount = 0

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
  // aud/iss はクライアントが認証した Firebase Auth プロジェクトで確定するため、
  // firebaseProjectId を優先する（gcpProjectId 優先だとマルチプロジェクト構成で
  // 全トークンが静かに検証失敗する: AUDIT-P8-1）
  const projectId = (config.public.firebaseProjectId || config.gcpProjectId || '') as string
  const uid = await verifyFirebaseIdToken(getRequestHeader(event, 'authorization'), projectId)

  if (!uid && process.env.NUXT_AI_REQUIRE_AUTH === 'true') {
    throw createError({
      statusCode: 401,
      statusMessage: `${ERROR_CODES.AUTH_REQUIRED}: AI 機能の利用にはサインイン（匿名認証）が必要です`,
    })
  }

  const now = Date.now()
  const ip = clientIpFromForwarded(
    getRequestHeader(event, 'x-forwarded-for'),
    event.node.req.socket?.remoteAddress,
  )
  // 認証済みは uid 上限（優遇）+ IP バックストップの二重キーで判定する。
  // uid のみだと匿名認証の量産で毎分上限を無制限に回避できるため（ISSUE-P8-5）
  const allowed = uid
    ? consumeToken(`uid:${uid}`, now, RATE_LIMIT_MAX_AUTHED) &&
      consumeToken(`ipa:${ip}`, now, RATE_LIMIT_MAX_IP_BACKSTOP)
    : consumeToken(`ip:${ip}`, now, RATE_LIMIT_MAX)

  if (!allowed) {
    throw createError({
      statusCode: 429,
      statusMessage: `${RATE_LIMIT_ERROR}: リクエストが多すぎます。しばらく待って再試行してください`,
    })
  }

  // 100 リクエストごとに期限切れバケットを掃除
  if (++requestCount % 100 === 0) pruneBuckets()
})

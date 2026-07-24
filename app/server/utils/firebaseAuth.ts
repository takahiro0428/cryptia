import { createRemoteJWKSet, jwtVerify } from 'jose'

/**
 * Firebase ID トークンの検証（AI API 認証強化: Phase 8）。
 * firebase-admin を使わず jose + Google 公開 JWKS で軽量に検証する
 * （Cloud Functions のコールドスタートを重くしないため）。
 */

const JWKS = createRemoteJWKSet(
  new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'),
)

/**
 * Bearer トークンを検証し、成功時は uid を返す。失敗・未設定は null。
 * projectId が未設定の環境では検証不能のため null（匿名扱い）。
 */
export async function verifyFirebaseIdToken(
  authorizationHeader: string | undefined,
  projectId: string,
): Promise<string | null> {
  if (!projectId || !authorizationHeader?.startsWith('Bearer ')) return null
  const token = authorizationHeader.slice(7).trim()
  if (!token) return null
  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: `https://securetoken.google.com/${projectId}`,
      audience: projectId,
    })
    const uid = typeof payload.sub === 'string' ? payload.sub : null
    return uid && uid.length > 0 && uid.length <= 128 ? uid : null
  } catch {
    return null
  }
}

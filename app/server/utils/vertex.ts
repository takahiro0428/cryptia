import { GoogleAuth } from 'google-auth-library'
import { ERROR_CODES } from '~/shared/errors'

/**
 * Vertex AI (Gemini) クライアント。
 * - 認証は ADC（Cloud Functions 実行 SA / ローカルは GOOGLE_APPLICATION_CREDENTIALS）
 * - プロジェクト未設定・呼び出し失敗時は null を返し、呼び出し元がフォールバックする（BR-5 / 原則4）
 */

let auth: GoogleAuth | null = null

function getAuth(): GoogleAuth {
  if (!auth) {
    auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] })
  }
  return auth
}

export interface VertexConfig {
  projectId: string
  location: string
  model: string
}

export function vertexConfig(): VertexConfig | null {
  // Nitro 外（単体テスト等）では useRuntimeConfig が存在しないため未設定扱いにする
  let config: { gcpProjectId?: string; vertexLocation?: string; vertexModel?: string }
  try {
    config = useRuntimeConfig()
  } catch {
    return null
  }
  const projectId = config.gcpProjectId || process.env.GOOGLE_CLOUD_PROJECT || ''
  if (!projectId) return null
  return {
    projectId,
    location: config.vertexLocation || 'asia-northeast1',
    model: config.vertexModel || 'gemini-2.0-flash',
  }
}

/**
 * Gemini にプロンプトを送りテキスト応答を得る。失敗時は null（例外を投げない）。
 */
export async function generateWithVertex(
  prompt: string,
  opts: { timeoutMs?: number } = {},
): Promise<string | null> {
  const cfg = vertexConfig()
  if (!cfg) return null

  try {
    const client = await getAuth().getClient()
    const token = await client.getAccessToken()
    if (!token.token) return null

    const url = `https://${cfg.location}-aiplatform.googleapis.com/v1/projects/${cfg.projectId}/locations/${cfg.location}/publishers/google/models/${cfg.model}:generateContent`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 9000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${token.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.4,
            maxOutputTokens: 1024,
            responseMimeType: 'application/json',
          },
        }),
      })
      if (!res.ok) {
        console.warn(`[${ERROR_CODES.AI_UNAVAILABLE}] Vertex AI HTTP ${res.status}`)
        return null
      }
      const data = (await res.json()) as {
        candidates?: { content?: { parts?: { text?: string }[] } }[]
      }
      return data.candidates?.[0]?.content?.parts?.[0]?.text ?? null
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    console.warn(
      `[${ERROR_CODES.AI_UNAVAILABLE}] Vertex AI 呼び出し失敗: ${err instanceof Error ? err.message : err}`,
    )
    return null
  }
}

/**
 * Vertex AI Embeddings（text-embedding-005）。ベクトル RAG の検索に使用する。
 * 未設定・失敗時は null（呼び出し元がキーワード検索へフォールバック）。
 */
export async function embedTexts(
  texts: string[],
  taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' = 'RETRIEVAL_DOCUMENT',
): Promise<number[][] | null> {
  const cfg = vertexConfig()
  if (!cfg || texts.length === 0) return null
  try {
    const client = await getAuth().getClient()
    const token = await client.getAccessToken()
    if (!token.token) return null
    const url = `https://${cfg.location}-aiplatform.googleapis.com/v1/projects/${cfg.projectId}/locations/${cfg.location}/publishers/google/models/text-embedding-005:predict`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 6000)
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instances: texts.map((text) => ({ content: text.slice(0, 2000), task_type: taskType })),
        }),
      })
      if (!res.ok) return null
      const data = (await res.json()) as {
        predictions?: { embeddings?: { values?: number[] } }[]
      }
      const vectors = (data.predictions ?? []).map((p) => p.embeddings?.values ?? [])
      return vectors.length === texts.length && vectors.every((v) => v.length > 0) ? vectors : null
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/** Gemini の JSON 応答を安全にパースする（コードフェンス除去込み）。失敗時 null */
export function parseJsonResponse<T>(text: string | null): T | null {
  if (!text) return null
  try {
    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '')
    return JSON.parse(cleaned) as T
  } catch {
    console.warn(`[${ERROR_CODES.AI_PARSE_FAILED}] AI 応答の JSON 解析に失敗`)
    return null
  }
}

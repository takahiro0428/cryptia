import { createHash } from 'node:crypto'
import { retrieveStrategies } from '~/shared/strategyPresets'
import type { StrategyDoc } from '~/shared/types'
import { embedTexts } from './vertex'

/**
 * ベクトル RAG（F-09 本格化）。
 * ユーザーの戦略ライブラリから、問い合わせ文脈に関連する戦略を検索して
 * AI プロンプトへ注入する。検索は 2 段構え:
 *   1. Vertex AI Embeddings によるコサイン類似度検索（設定済み環境）
 *   2. キーワード一致検索（shared/strategyPresets.retrieveStrategies）へフォールバック
 * ドキュメント埋め込みは内容ハッシュをキーにメモリキャッシュし、再計算を避ける。
 */

const embeddingCache = new Map<string, number[]>()
const CACHE_MAX = 500

function docKey(doc: StrategyDoc): string {
  return createHash('sha256').update(`${doc.name}\n${doc.content}`).digest('hex')
}

function cosine(a: number[], b: number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb)
  return denom === 0 ? 0 : dot / denom
}

/**
 * 関連戦略を検索する。activeId のドキュメントは除外（本文は別途注入されるため）。
 */
export async function retrieveRelevantStrategies(
  docs: StrategyDoc[],
  query: string,
  opts: { excludeId?: string; limit?: number } = {},
): Promise<{ docs: StrategyDoc[]; method: 'vector' | 'keyword' }> {
  const limit = opts.limit ?? 2
  const candidates = docs.filter((d) => d.id !== opts.excludeId)
  if (candidates.length === 0) return { docs: [], method: 'keyword' }

  // --- ベクトル検索（Vertex Embeddings） ---
  const uncached = candidates.filter((d) => !embeddingCache.has(docKey(d)))
  const toEmbed = [query, ...uncached.map((d) => `${d.name}\n${d.content}`)]
  const vectors = await embedTexts(toEmbed)
  if (vectors) {
    const queryVec = vectors[0]
    uncached.forEach((d, i) => {
      if (embeddingCache.size >= CACHE_MAX) {
        const first = embeddingCache.keys().next().value
        if (first) embeddingCache.delete(first)
      }
      embeddingCache.set(docKey(d), vectors[i + 1])
    })
    const scored = candidates
      .map((d) => ({ d, score: cosine(queryVec, embeddingCache.get(docKey(d)) ?? []) }))
      .sort((a, b) => b.score - a.score)
      .filter((s) => s.score > 0.3)
      .slice(0, limit)
    return { docs: scored.map((s) => s.d), method: 'vector' }
  }

  // --- キーワード検索フォールバック ---
  return { docs: retrieveStrategies(candidates, query, limit), method: 'keyword' }
}

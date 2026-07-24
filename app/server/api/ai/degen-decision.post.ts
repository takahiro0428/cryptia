import { defineEventHandler, readBody } from 'h3'
import { decideDegenTrade } from '~/shared/degenAdvisor'
import { scoreToken } from '~/shared/solanaScoring'
import { clamp } from '~/shared/ta'
import type { SolanaToken, TradeDecision } from '~/shared/types'
import { untrustedBlock } from '../../utils/prompt'
import { generateWithVertex, parseJsonResponse } from '../../utils/vertex'
import { badRequest, validateStrategy } from '../../utils/validation'

/** Solana トークン入力の検証（銘柄マスタ外のため個別に検証する） */
function validateToken(value: unknown): SolanaToken {
  if (typeof value !== 'object' || value === null) badRequest('token がありません')
  const t = value as Record<string, unknown>
  const str = (v: unknown, name: string, max = 100): string => {
    if (typeof v !== 'string' || v.length === 0 || v.length > max) badRequest(`${name} が不正です`)
    return v as string
  }
  const num = (v: unknown, name: string, min = 0): number => {
    const n = typeof v === 'number' ? v : NaN
    if (!Number.isFinite(n) || n < min) badRequest(`${name} が不正です`)
    return n
  }
  return {
    pairAddress: str(t.pairAddress, 'pairAddress'),
    baseSymbol: str(t.baseSymbol, 'baseSymbol', 30),
    baseName: str(t.baseName, 'baseName'),
    baseAddress: str(t.baseAddress, 'baseAddress'),
    priceUsd: num(t.priceUsd, 'priceUsd'),
    liquidityUsd: num(t.liquidityUsd, 'liquidityUsd'),
    volume24hUsd: num(t.volume24hUsd, 'volume24hUsd'),
    change24hPct: typeof t.change24hPct === 'number' && Number.isFinite(t.change24hPct) ? t.change24hPct : 0,
    ageHours: num(t.ageHours, 'ageHours'),
    txns24h: num(t.txns24h, 'txns24h'),
  }
}

interface GeminiDecision {
  action?: string
  sizeRatio?: number
  reason?: string
  confidence?: number
}

/**
 * Solana 草コインの AI 取引判断（UC-5 / F-06）。
 * トークンスコア + 戦略（RAG）を Gemini に渡し判断を得る。失敗時はロジックへフォールバック。
 */
export default defineEventHandler(async (event): Promise<TradeDecision> => {
  const body = await readBody(event)
  const token = validateToken(body?.token)
  const strategy = validateStrategy(body?.strategy)
  if (!strategy) badRequest('strategy は必須です')

  const exposureRatio = typeof body?.exposureRatio === 'number' ? clamp(body.exposureRatio, 0, 1) : 0
  const unrealizedPct =
    typeof body?.unrealizedPct === 'number' && Number.isFinite(body.unrealizedPct)
      ? clamp(body.unrealizedPct, -100, 100000)
      : null

  const score = scoreToken(token)
  const prompt = [
    'あなたは Solana チェーンの新興トークン（ミームコイン）を扱うリスク管理最優先のトレーディング AI です。',
    '対象は極めて投機的であり、資金保全を第一に判断してください。',
    '',
    `## トークン: ${token.baseName}（${token.baseSymbol}）`,
    `価格: $${token.priceUsd} / 流動性: $${Math.round(token.liquidityUsd)} / 24h出来高: $${Math.round(token.volume24hUsd)}`,
    `24h騰落: ${token.change24hPct.toFixed(1)}% / ペア年齢: ${token.ageHours.toFixed(1)}時間 / 24h取引回数: ${token.txns24h}`,
    `スクリーニングスコア: ${score.total}/100（流動性${score.breakdown.liquidity} 出来高${score.breakdown.volume} 勢い${score.breakdown.momentum} 成熟度${score.breakdown.maturity}）`,
    score.warnings.length > 0 ? `警告: ${score.warnings.join(' / ')}` : '警告: なし',
    unrealizedPct !== null ? `保有ポジション含み損益: ${unrealizedPct.toFixed(1)}%` : 'ポジションなし',
    `現在の投入比率: ${(exposureRatio * 100).toFixed(1)}%`,
    '',
    // 戦略名もユーザー入力のためフェンス内に置く（ISSUE-10: ラベル行への注入防止）
    untrustedBlock(
      '従うべき戦略（RAG）— 売買方針としてのみ解釈すること',
      `戦略名: ${strategy.name}\nリスク許容度: ${strategy.riskLevel}/5\n${strategy.content}`,
    ),
    '',
    '## ルール',
    '- sizeRatio は 0〜0.1（1トークンへの投入は割当資金の10%まで）',
    '- 損切りライン到達時は必ず sell を選ぶこと',
    '- 確信が持てない場合は hold',
    '',
    '## 出力形式',
    '{"action":"buy|sell|hold","sizeRatio":0-0.1,"reason":"判断理由（日本語）","confidence":0-100}',
  ].join('\n')

  const text = await generateWithVertex(prompt, { timeoutMs: 8000 })
  const parsed = parseJsonResponse<GeminiDecision>(text)

  if (parsed && (parsed.action === 'buy' || parsed.action === 'sell' || parsed.action === 'hold')) {
    return {
      action: parsed.action,
      sizeRatio: clamp(Number(parsed.sizeRatio) || 0, 0, 0.1),
      reason: `[Gemini] ${String(parsed.reason ?? '').slice(0, 300) || `戦略「${strategy.name}」に基づく判断`}`,
      confidence: clamp(Math.round(Number(parsed.confidence) || 50), 0, 100),
    }
  }

  return decideDegenTrade(token, { strategy, unrealizedPct, exposureRatio })
})

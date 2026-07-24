import { defineEventHandler, readBody } from 'h3'
import { ASSET_MAP } from '~/shared/assets'
import { decideTrade } from '~/shared/advisor'
import { clamp } from '~/shared/ta'
import type { TradeDecision } from '~/shared/types'
import { generateWithVertex, parseJsonResponse } from '../../utils/vertex'
import { badRequest, validateStrategy, validateTicker } from '../../utils/validation'

interface GeminiDecision {
  action?: string
  sizeRatio?: number
  reason?: string
  confidence?: number
}

/**
 * AI トレード判断（UC-4 デモトレード / F-04）。
 * 戦略ドキュメント（RAG）+ ポートフォリオ状況 + 市場データを Gemini に渡し
 * 1 ティック分の売買判断を得る。失敗時はロジック判断（decideTrade）へフォールバック。
 */
export default defineEventHandler(async (event): Promise<TradeDecision> => {
  const body = await readBody(event)
  const ticker = validateTicker(body?.ticker)
  const strategy = validateStrategy(body?.strategy)
  if (!strategy) badRequest('strategy は必須です')

  const exposureRatio = typeof body?.exposureRatio === 'number' ? clamp(body.exposureRatio, 0, 1) : 0
  const unrealizedPct =
    typeof body?.unrealizedPct === 'number' && Number.isFinite(body.unrealizedPct)
      ? clamp(body.unrealizedPct, -100, 100000)
      : null
  const asset = ASSET_MAP[ticker.assetId]

  const prompt = [
    'あなたはリスク管理を最優先するトレーディング AI です。次の1ティックの行動を決定してください。',
    '',
    `## 銘柄: ${asset?.nameJa ?? ticker.assetId}（${asset?.symbol}）`,
    `現在価格: $${ticker.priceUsd} / 24h ${ticker.change24hPct.toFixed(2)}% / 7d ${ticker.change7dPct.toFixed(2)}%`,
    `この銘柄への現在の投入比率: ${(exposureRatio * 100).toFixed(1)}%（総資産比）`,
    unrealizedPct !== null ? `保有ポジションの含み損益: ${unrealizedPct.toFixed(1)}%` : '現在ポジションなし',
    '',
    '## 従うべきトレード戦略（RAG）',
    `戦略名: ${strategy.name}（リスク許容度 ${strategy.riskLevel}/5）`,
    strategy.content,
    '',
    '## ルール',
    '- sizeRatio は総資産に対する比率（buy 時）またはポジションに対する比率（sell 時）で 0〜0.3 の範囲',
    '- 戦略に反する行動をしてはならない。判断根拠に戦略名を含めること',
    '- 確信が持てない場合は hold を選ぶこと',
    '',
    '## 出力形式',
    '次の JSON のみを出力（日本語）:',
    '{"action":"buy|sell|hold","sizeRatio":0-0.3,"reason":"判断理由（戦略名を含む）","confidence":0-100}',
  ].join('\n')

  const text = await generateWithVertex(prompt, { timeoutMs: 8000 })
  const parsed = parseJsonResponse<GeminiDecision>(text)

  if (parsed && (parsed.action === 'buy' || parsed.action === 'sell' || parsed.action === 'hold')) {
    return {
      action: parsed.action,
      sizeRatio: clamp(Number(parsed.sizeRatio) || 0, 0, 0.3),
      reason: `[Gemini] ${String(parsed.reason ?? '').slice(0, 300) || `戦略「${strategy.name}」に基づく判断`}`,
      confidence: clamp(Math.round(Number(parsed.confidence) || 50), 0, 100),
    }
  }

  // フォールバック: 決定論ロジック
  return decideTrade(ticker, { strategy, exposureRatio, unrealizedPct })
})

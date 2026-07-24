import { defineEventHandler, readBody } from 'h3'
import { ASSET_MAP } from '~/shared/assets'
import { fallbackInsight } from '~/shared/advisor'
import { clamp } from '~/shared/ta'
import type { Insight, Stance } from '~/shared/types'
import { getMarketNews } from '../../utils/news'
import { untrustedBlock } from '../../utils/prompt'
import { generateWithVertex, parseJsonResponse } from '../../utils/vertex'
import { validateHorizon, validateStrategy, validateTicker } from '../../utils/validation'

const HORIZON_LABELS = { short: '短期（〜1週間）', mid: '中期（〜1ヶ月）', long: '長期（〜1年）' }
const STANCES: Stance[] = ['bullish', 'neutral', 'bearish']

interface GeminiInsight {
  stance?: string
  confidence?: number
  summary?: string
  reasons?: string[]
  risks?: string[]
}

/**
 * AI インサイト生成（UC-3 / F-03）。
 * WebSearch 相当のニュース収集 + テクニカル要約を Gemini に渡し、
 * RAG 戦略（選択中の戦略ドキュメント）をコンテキスト注入する。
 * Vertex AI 未設定・失敗時はテクニカル指標フォールバック（BR-5）。
 */
export default defineEventHandler(async (event): Promise<Insight> => {
  const body = await readBody(event)
  const ticker = validateTicker(body?.ticker)
  const horizon = validateHorizon(body?.horizon)
  const strategy = validateStrategy(body?.strategy)
  const asset = ASSET_MAP[ticker.assetId]

  const news = await getMarketNews()
  const newsBlock =
    news.length > 0
      ? news
          .slice(0, 8)
          .map((n) => `- ${n.title}（${n.source}）`)
          .join('\n')
      : '（ニュース取得なし）'

  const prompt = [
    'あなたは暗号資産・トークン化資産のプロアナリストです。以下の情報から売買スタンスを分析してください。',
    '',
    `## 分析対象`,
    `${asset?.nameJa ?? ticker.assetId}（${asset?.symbol ?? '?'}） / 時間軸: ${HORIZON_LABELS[horizon]}`,
    '',
    '## 市場データ',
    `現在価格: $${ticker.priceUsd}`,
    `騰落率: 1h ${ticker.change1hPct.toFixed(2)}% / 24h ${ticker.change24hPct.toFixed(2)}% / 7d ${ticker.change7dPct.toFixed(2)}%`,
    `時価総額: $${ticker.marketCapUsd} / 24h出来高: $${ticker.volume24hUsd}`,
    '',
    untrustedBlock('最新ニュース見出し（参考データ）', newsBlock),
    '',
    ...(strategy
      ? [
          // 戦略名もユーザー入力のためフェンス内に置く（ISSUE-10: ラベル行への注入防止）
          untrustedBlock(
            'ユーザーのトレード戦略 — 売買方針の判断材料として整合性を考慮すること',
            `戦略名: ${strategy.name}\nリスク許容度: ${strategy.riskLevel}/5\n${strategy.content}`,
          ),
          '',
        ]
      : []),
    '## 出力形式',
    '次の JSON のみを出力（コードフェンス不要・日本語）:',
    '{"stance":"bullish|neutral|bearish","confidence":0-100の数値,"summary":"1〜2文の要約","reasons":["根拠を2〜4個"],"risks":["リスクを1〜3個"]}',
  ].join('\n')

  const text = await generateWithVertex(prompt)
  const parsed = parseJsonResponse<GeminiInsight>(text)

  if (
    parsed &&
    typeof parsed.stance === 'string' &&
    STANCES.includes(parsed.stance as Stance) &&
    typeof parsed.summary === 'string'
  ) {
    const sources = ['Vertex AI (Gemini) 分析', 'テクニカル指標・市場データ']
    if (news.length > 0) sources.push(`ニュース ${Math.min(news.length, 8)} 件（${[...new Set(news.slice(0, 8).map((n) => n.source))].join(' / ')}）`)
    if (strategy) sources.push(`戦略「${strategy.name}」`)
    return {
      assetId: ticker.assetId,
      horizon,
      stance: parsed.stance as Stance,
      confidence: clamp(Math.round(Number(parsed.confidence) || 50), 0, 100),
      summary: String(parsed.summary).slice(0, 500),
      reasons: (parsed.reasons ?? []).map((r) => String(r).slice(0, 300)).slice(0, 5),
      risks: (parsed.risks ?? []).map((r) => String(r).slice(0, 300)).slice(0, 4),
      sources,
      engine: 'vertex-ai',
      generatedAt: Date.now(),
    }
  }

  // フォールバック（AI 未設定・障害・解析失敗）
  return fallbackInsight(ticker, horizon, strategy)
})

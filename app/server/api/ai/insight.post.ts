import { defineEventHandler, readBody } from 'h3'
import { ASSET_MAP } from '~/shared/assets'
import { computeEntryRanges, fallbackInsight } from '~/shared/advisor'
import { clamp } from '~/shared/ta'
import type { EntryRange, Insight, Stance, Ticker } from '~/shared/types'
import { filterNewsForAsset, getMarketNews } from '../../utils/news'
import { untrustedBlock } from '../../utils/prompt'
import { retrieveRelevantStrategies } from '../../utils/rag'
import { generateWithVertex, parseJsonResponse } from '../../utils/vertex'
import {
  validateHorizon,
  validateStrategy,
  validateStrategyLibrary,
  validateTicker,
} from '../../utils/validation'

const HORIZON_LABELS = { short: '短期（〜1週間）', mid: '中期（〜1ヶ月）', long: '長期（〜1年）' }
const STANCES: Stance[] = ['bullish', 'neutral', 'bearish']

interface GeminiRange {
  min?: number
  max?: number
  note?: string
}

interface GeminiInsight {
  stance?: string
  confidence?: number
  summary?: string
  reasons?: string[]
  risks?: string[]
  entryLong?: GeminiRange
  entryShort?: GeminiRange
}

/**
 * Gemini 応答のエントリーレンジ検証。min<max・現値±50% 以内でない場合は
 * テクニカル算出のフォールバック値を返す（架空水準の提示を防ぐ）。
 */
function sanitizeRange(
  raw: GeminiRange | undefined,
  fallback: EntryRange,
  ticker: Ticker,
): EntryRange {
  const min = Number(raw?.min)
  const max = Number(raw?.max)
  const price = ticker.priceUsd
  const within = (v: number) => Number.isFinite(v) && v > price * 0.5 && v < price * 1.5
  if (!within(min) || !within(max) || min >= max) return fallback
  return { minUsd: min, maxUsd: max, note: String(raw?.note ?? '').slice(0, 120) || fallback.note }
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
  const library = validateStrategyLibrary(body?.library)
  const asset = ASSET_MAP[ticker.assetId]

  // ニュースは対象銘柄に関連する見出しを優先する（F-10 本格化）
  const news = filterNewsForAsset(await getMarketNews(), asset)
  const newsBlock =
    news.length > 0
      ? news
          .slice(0, 8)
          .map((n) => `- ${n.title}（${n.source}）`)
          .join('\n')
      : '（ニュース取得なし）'

  // ベクトル RAG: 戦略ライブラリから関連ノウハウを検索して文脈注入（F-09 本格化）
  const rag = await retrieveRelevantStrategies(
    library,
    `${asset?.nameJa ?? ''} ${asset?.symbol ?? ''} ${horizon === 'short' ? '短期' : horizon === 'mid' ? '中期' : '長期'} トレード ${ticker.change24hPct >= 0 ? '上昇' : '下落'}`,
    { excludeId: strategy?.id },
  )

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
    ...(rag.docs.length > 0
      ? [
          untrustedBlock(
            '参考: ユーザーの戦略ライブラリから検索された関連ノウハウ（補助的な判断材料）',
            rag.docs.map((d) => `【${d.name}】\n${d.content}`).join('\n\n'),
          ),
          '',
        ]
      : []),
    '## 出力形式',
    '次の JSON のみを出力（コードフェンス不要・日本語）。',
    'entryLong はロングの押し目買いゾーン、entryShort はショートの戻り売りゾーン。',
    'いずれも現在価格を基準に、サポート/レジスタンス・ボラティリティを考慮した現実的な USD 水準にすること:',
    '{"stance":"bullish|neutral|bearish","confidence":0-100の数値,"summary":"1〜2文の要約","reasons":["根拠を2〜4個"],"risks":["リスクを1〜3個"],' +
      '"entryLong":{"min":数値,"max":数値,"note":"ゾーンの根拠を短く"},"entryShort":{"min":数値,"max":数値,"note":"ゾーンの根拠を短く"}}',
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
    if (rag.docs.length > 0) {
      sources.push(
        `RAG 検索（${rag.method === 'vector' ? 'ベクトル' : 'キーワード'}）: ${rag.docs.map((d) => d.name).join(' / ')}`,
      )
    }
    // エントリーレンジは Gemini 提案を検証し、不正時はテクニカル算出へフォールバック
    const fallbackRanges = computeEntryRanges(ticker)
    return {
      assetId: ticker.assetId,
      horizon,
      stance: parsed.stance as Stance,
      confidence: clamp(Math.round(Number(parsed.confidence) || 50), 0, 100),
      summary: String(parsed.summary).slice(0, 500),
      reasons: (parsed.reasons ?? []).map((r) => String(r).slice(0, 300)).slice(0, 5),
      risks: (parsed.risks ?? []).map((r) => String(r).slice(0, 300)).slice(0, 4),
      entryRanges: {
        long: sanitizeRange(parsed.entryLong, fallbackRanges.long, ticker),
        short: sanitizeRange(parsed.entryShort, fallbackRanges.short, ticker),
      },
      sources,
      engine: 'vertex-ai',
      generatedAt: Date.now(),
    }
  }

  // フォールバック（AI 未設定・障害・解析失敗）
  return fallbackInsight(ticker, horizon, strategy)
})

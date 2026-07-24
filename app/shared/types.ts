/** 共有型定義。クライアント・サーバー・テストの全レイヤーで使用する。 */

/** 資産クラス。仮想通貨に加え株式トークン・ゴールドトークンを扱う */
export type AssetClass = 'crypto' | 'stock-token' | 'gold-token'

/** 銘柄マスタ（静的マスタ: shared/assets.ts で定義） */
export interface Asset {
  /** CoinGecko の coin id（例: bitcoin）。内部の主キーとしても使用 */
  id: string
  symbol: string
  name: string
  nameJa: string
  class: AssetClass
  color: string
}

/** ティッカー（リアルタイム価格スナップショット） */
export interface Ticker {
  assetId: string
  priceUsd: number
  change1hPct: number
  change24hPct: number
  change7dPct: number
  marketCapUsd: number
  volume24hUsd: number
  sparkline7d: number[]
  updatedAt: number
}

/** 銘柄間の推定資金フロー（バブルマップの矢印1本分） */
export interface FundFlow {
  fromAssetId: string
  toAssetId: string
  /** 推定フロー量（USD 相当のスコア） */
  amountUsd: number
}

export type FlowPeriod = '1h' | '24h' | '7d'

/** AI インサイトの時間軸 */
export type Horizon = 'short' | 'mid' | 'long'

export type Stance = 'bullish' | 'neutral' | 'bearish'

/** おすすめエントリーレンジ（ロング/ショート別の指値ゾーン） */
export interface EntryRange {
  minUsd: number
  maxUsd: number
  note: string
}

/** AI（または フォールバック分析）が生成するインサイト */
export interface Insight {
  assetId: string
  horizon: Horizon
  stance: Stance
  /** 確信度 0-100 */
  confidence: number
  summary: string
  reasons: string[]
  risks: string[]
  /** ロング/ショート別のおすすめエントリーレンジ */
  entryRanges?: { long: EntryRange; short: EntryRange }
  /** 使用した情報ソースの明示（BR-4） */
  sources: string[]
  /** 'vertex-ai' = Gemini 生成 / 'fallback' = テクニカル指標ベース */
  engine: 'vertex-ai' | 'fallback'
  generatedAt: number
}

/** 売買サイド */
export type OrderSide = 'buy' | 'sell'

/** デモ/実トレード共通の注文レコード（追記型・巻き戻し禁止: BR-7） */
export interface Order {
  id: string
  assetId: string
  side: OrderSide
  /** 約定数量（資産単位） */
  quantity: number
  /** 約定単価 USD */
  priceUsd: number
  /** 約定金額 USD */
  notionalUsd: number
  /** 実現損益 USD（売りのみ） */
  realizedPnlUsd: number
  /** AI/ロジックの判断理由（BR-4） */
  reason: string
  /** 判断に使った戦略名 */
  strategy: string
  executedAt: number
}

export interface Position {
  assetId: string
  quantity: number
  avgCostUsd: number
}

/** デモトレードのポートフォリオ状態 */
export interface Portfolio {
  /** 現金残高 USD */
  cashUsd: number
  initialUsd: number
  positions: Position[]
  orders: Order[]
  /** 資産推移（サマリーチャート用） */
  equityCurve: { at: number; equityUsd: number }[]
}

/** トレード判断（AI・ロジック・フォールバック共通の出力形式） */
export interface TradeDecision {
  action: OrderSide | 'hold'
  /** ポートフォリオ資産に対する発注比率 0-1 */
  sizeRatio: number
  reason: string
  confidence: number
}

/** RAG 戦略ドキュメント */
export interface StrategyDoc {
  id: string
  name: string
  /** 自然言語のルール記述。AI プロンプトへ注入される */
  content: string
  /** 検索用タグ（キーワード RAG） */
  tags: string[]
  /** プリセット（削除不可）か ユーザー作成か */
  builtin: boolean
  /** リスク許容度 1(保守的)-5(積極的) */
  riskLevel: number
  updatedAt: number
}

/** Solana 新興トークン（DexScreener 由来） */
export interface SolanaToken {
  pairAddress: string
  baseSymbol: string
  baseName: string
  baseAddress: string
  priceUsd: number
  liquidityUsd: number
  volume24hUsd: number
  change24hPct: number
  /** ペア作成からの経過時間（時間） */
  ageHours: number
  txns24h: number
}

/** Solana トークンの安全性・妙味スコア */
export interface TokenScore {
  token: SolanaToken
  /** 総合 0-100 */
  total: number
  breakdown: {
    liquidity: number
    volume: number
    momentum: number
    maturity: number
  }
  warnings: string[]
}

/** ロジック取引のラダールール（例: +100% で 50% 利確） */
export interface LadderRule {
  /** 発動する騰落率（%）。正=利確 負=損切り */
  triggerPct: number
  /** 決済するポジション比率 0-1 */
  sellRatio: number
}

/** 実トレードの安全ガード設定（BR-2） */
export interface TradeGuardConfig {
  riskConsentAt: number | null
  /** 1回あたり上限 USD */
  maxPerTradeUsd: number
  /** 1日あたり上限 USD */
  maxPerDayUsd: number
  autoTradeEnabled: boolean
}

/** ニュース項目（AI コンテキスト用） */
export interface NewsItem {
  title: string
  url: string
  source: string
  publishedAt: number
}

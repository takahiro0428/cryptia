/**
 * エラーコード一元管理（CRYPTIA-Exxx）
 * 想定エラーには必ずここで定義したコードを付与する（Phase 7 ゲート条件）。
 * 逆引きリファレンス: .ai-native/outputs/knowledge-base/ops-guide/error-code-reference.md
 */
export const ERROR_CODES = {
  /** 外部の価格 API から取得に失敗（ネットワーク・レートリミット） */
  MARKET_FETCH_FAILED: 'CRYPTIA-E101',
  /** DEX（DexScreener）API から取得に失敗 */
  DEX_FETCH_FAILED: 'CRYPTIA-E102',
  /** ニュースソースから取得に失敗 */
  NEWS_FETCH_FAILED: 'CRYPTIA-E103',
  /** Vertex AI 呼び出しに失敗（フォールバック分析に切替） */
  AI_UNAVAILABLE: 'CRYPTIA-E201',
  /** AI 応答の解析に失敗（フォールバック分析に切替） */
  AI_PARSE_FAILED: 'CRYPTIA-E202',
  /** リクエスト入力の検証エラー */
  INVALID_INPUT: 'CRYPTIA-E301',
  /** AI API のレートリミット超過（時間をおいて再試行） */
  RATE_LIMITED: 'CRYPTIA-E302',
  /** AI API の認証必須環境で未認証リクエストを拒否 */
  AUTH_REQUIRED: 'CRYPTIA-E303',
  /** アカウントリンク（匿名→Google）に失敗 */
  ACCOUNT_LINK_FAILED: 'CRYPTIA-E602',
  /** デモトレード: 資金不足で注文を拒否 */
  INSUFFICIENT_FUNDS: 'CRYPTIA-E401',
  /** デモトレード: 保有数量不足で売り注文を拒否 */
  INSUFFICIENT_POSITION: 'CRYPTIA-E402',
  /** 実トレード: リスク同意・取引上限が未設定のまま自動取引を要求 */
  TRADE_GUARD_BLOCKED: 'CRYPTIA-E501',
  /** 実トレード: 取引上限超過のため注文を拒否 */
  TRADE_LIMIT_EXCEEDED: 'CRYPTIA-E502',
  /** ウォレット未接続・接続失敗 */
  WALLET_NOT_CONNECTED: 'CRYPTIA-E503',
  /** スワップ見積り（Jupiter）取得に失敗 */
  SWAP_QUOTE_FAILED: 'CRYPTIA-E504',
  /** Firestore 同期に失敗（ローカル保存で継続） */
  SYNC_FAILED: 'CRYPTIA-E601',
} as const

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES]

/** アプリ内で送出する想定エラー。message はユーザー提示可能な日本語で書く。 */
export class CryptiaError extends Error {
  readonly code: ErrorCode
  /** 補助処理の失敗など、主要フローを止めるべきでないエラーか（原則4） */
  readonly recoverable: boolean

  constructor(code: ErrorCode, message: string, recoverable = true) {
    super(message)
    this.name = 'CryptiaError'
    this.code = code
    this.recoverable = recoverable
  }
}

/** エラーを「コード付きで報告しつつ処理は継続する」ためのログ整形 */
export function formatError(err: unknown): { code: ErrorCode | 'CRYPTIA-E999'; message: string } {
  if (err instanceof CryptiaError) return { code: err.code, message: err.message }
  return { code: 'CRYPTIA-E999', message: err instanceof Error ? err.message : String(err) }
}

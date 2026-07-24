import { CryptiaError, ERROR_CODES } from './errors'
import type { LadderRule, Order, OrderSide, Portfolio, Position, TradeDecision } from './types'

/**
 * デモトレードエンジン（純関数群）。
 * - 注文・履歴は追記型で、既存レコードを書き換えない（BR-7 / 原則2）
 * - 資金不足・数量不足はエラーコード付きで拒否する
 */

export function createPortfolio(initialUsd: number, now = Date.now()): Portfolio {
  if (!Number.isFinite(initialUsd) || initialUsd <= 0) {
    throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '初期資金は正の数値で指定してください')
  }
  return {
    cashUsd: initialUsd,
    initialUsd,
    positions: [],
    orders: [],
    equityCurve: [{ at: now, equityUsd: initialUsd }],
  }
}

let orderSeq = 0
function nextOrderId(now: number): string {
  orderSeq = (orderSeq + 1) % 1_000_000
  return `ord-${now.toString(36)}-${orderSeq.toString(36)}`
}

export function positionOf(portfolio: Portfolio, assetId: string): Position | undefined {
  return portfolio.positions.find((p) => p.assetId === assetId)
}

/** 総資産評価額（現金 + 保有ポジション時価） */
export function portfolioEquity(portfolio: Portfolio, prices: Record<string, number>): number {
  const positionsValue = portfolio.positions.reduce(
    (s, p) => s + p.quantity * (prices[p.assetId] ?? p.avgCostUsd),
    0,
  )
  return portfolio.cashUsd + positionsValue
}

/**
 * 注文を執行し、新しいポートフォリオを返す（元オブジェクトは変更しない）。
 * 金額指定（notionalUsd）または数量指定（quantity）のどちらかで発注する。
 * 保有数量ベースの売り（損切り・ラダー決済等）は quantity 指定を使うこと。
 * notionalUsd → quantity の逆算は浮動小数点誤差を含むため、全量売却が
 * INSUFFICIENT_POSITION で欠けたりダスト・ポジションが残る原因になる。
 * @throws CryptiaError INSUFFICIENT_FUNDS / INSUFFICIENT_POSITION / INVALID_INPUT
 */
export function executeOrder(
  portfolio: Portfolio,
  input: {
    assetId: string
    side: OrderSide
    priceUsd: number
    reason: string
    strategy: string
    at?: number
    /** 約定金額 USD（quantity 未指定時に必須） */
    notionalUsd?: number
    /** 約定数量（指定時は notionalUsd より優先） */
    quantity?: number
  },
): { portfolio: Portfolio; order: Order } {
  const { assetId, side, priceUsd, reason, strategy } = input
  const at = input.at ?? Date.now()

  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '価格は正の数値で指定してください')
  }
  const hasQty = input.quantity !== undefined
  if (hasQty && (!Number.isFinite(input.quantity!) || input.quantity! <= 0)) {
    throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '注文数量は正の数値で指定してください')
  }
  if (!hasQty && (!Number.isFinite(input.notionalUsd!) || (input.notionalUsd ?? 0) <= 0)) {
    throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '注文金額は正の数値で指定してください')
  }

  const existing = positionOf(portfolio, assetId)
  let quantity = hasQty ? input.quantity! : input.notionalUsd! / priceUsd
  // 保有数量との相対許容誤差（マイクロプライス銘柄では絶対誤差が数量スケールに届かないため）
  const tolerance = existing ? existing.quantity * 1e-9 + Number.EPSILON : 0

  if (side === 'sell') {
    if (!existing || existing.quantity < quantity - tolerance) {
      throw new CryptiaError(
        ERROR_CODES.INSUFFICIENT_POSITION,
        `保有数量を超える売り注文は執行できません（保有: ${existing?.quantity.toFixed(6) ?? 0}）`,
      )
    }
    // 許容誤差内の超過は「全量売却」とみなして保有数量に丸める
    if (quantity > existing.quantity) quantity = existing.quantity
  }
  const notionalUsd = hasQty || side === 'sell' ? quantity * priceUsd : input.notionalUsd!

  let realizedPnlUsd = 0
  let cashUsd = portfolio.cashUsd
  let positions: Position[]

  if (side === 'buy') {
    if (notionalUsd > portfolio.cashUsd * (1 + 1e-12) + 1e-9) {
      throw new CryptiaError(
        ERROR_CODES.INSUFFICIENT_FUNDS,
        `現金残高（$${portfolio.cashUsd.toFixed(2)}）を超える買い注文は執行できません`,
      )
    }
    cashUsd -= notionalUsd
    if (existing) {
      const newQty = existing.quantity + quantity
      const newCost = (existing.avgCostUsd * existing.quantity + notionalUsd) / newQty
      positions = portfolio.positions.map((p) =>
        p.assetId === assetId ? { ...p, quantity: newQty, avgCostUsd: newCost } : p,
      )
    } else {
      positions = [...portfolio.positions, { assetId, quantity, avgCostUsd: priceUsd }]
    }
  } else {
    cashUsd += notionalUsd
    realizedPnlUsd = (priceUsd - existing!.avgCostUsd) * quantity
    const remaining = existing!.quantity - quantity
    // 相対許容誤差以下の残量はダストとして削除する
    positions =
      remaining <= tolerance
        ? portfolio.positions.filter((p) => p.assetId !== assetId)
        : portfolio.positions.map((p) =>
            p.assetId === assetId ? { ...p, quantity: remaining } : p,
          )
  }

  const order: Order = {
    id: nextOrderId(at),
    assetId,
    side,
    quantity,
    priceUsd,
    notionalUsd,
    realizedPnlUsd,
    reason,
    strategy,
    executedAt: at,
  }

  return {
    portfolio: {
      ...portfolio,
      cashUsd,
      positions,
      orders: [...portfolio.orders, order],
    },
    order,
  }
}

/**
 * AI/ロジックの判断（TradeDecision）を1件適用する。
 * hold・ゼロサイズ・執行不能（残高不足等）の場合は何もせず null を返す。
 */
export function applyDecision(
  portfolio: Portfolio,
  decision: TradeDecision,
  ctx: { assetId: string; priceUsd: number; strategy: string; at?: number; prices: Record<string, number> },
): { portfolio: Portfolio; order: Order } | null {
  if (decision.action === 'hold' || decision.sizeRatio <= 0) return null

  const equity = portfolioEquity(portfolio, ctx.prices)
  if (decision.action === 'buy') {
    const notionalUsd = Math.min(equity * decision.sizeRatio, portfolio.cashUsd)
    if (notionalUsd < 1) return null // $1 未満の端数注文は無視
    return executeOrder(portfolio, {
      assetId: ctx.assetId,
      side: 'buy',
      notionalUsd,
      priceUsd: ctx.priceUsd,
      reason: decision.reason,
      strategy: ctx.strategy,
      at: ctx.at,
    })
  }

  const pos = positionOf(portfolio, ctx.assetId)
  if (!pos) return null
  // 数量指定で発注する（notional 逆算の浮動小数点誤差で全量売却が欠けるのを防ぐ）
  const sellQty = pos.quantity * Math.min(decision.sizeRatio, 1)
  if (sellQty * ctx.priceUsd < 1) return null
  return executeOrder(portfolio, {
    assetId: ctx.assetId,
    side: 'sell',
    quantity: sellQty,
    priceUsd: ctx.priceUsd,
    reason: decision.reason,
    strategy: ctx.strategy,
    at: ctx.at,
  })
}

/** 資産推移を記録する（equityCurve は追記型・最大 500 点に間引き） */
export function recordEquity(
  portfolio: Portfolio,
  prices: Record<string, number>,
  at = Date.now(),
): Portfolio {
  const equityUsd = portfolioEquity(portfolio, prices)
  const curve = [...portfolio.equityCurve, { at, equityUsd }]
  const trimmed = curve.length > 500 ? curve.filter((_, i) => i % 2 === 0 || i === curve.length - 1) : curve
  return { ...portfolio, equityCurve: trimmed }
}

export interface PortfolioSummary {
  equityUsd: number
  totalPnlUsd: number
  totalPnlPct: number
  realizedPnlUsd: number
  tradeCount: number
  winCount: number
  lossCount: number
  winRatePct: number
  maxDrawdownPct: number
}

/** サマリー統計（UC-4: 勝率・最大ドローダウン等） */
export function summarize(portfolio: Portfolio, prices: Record<string, number>): PortfolioSummary {
  const equityUsd = portfolioEquity(portfolio, prices)
  const sells = portfolio.orders.filter((o) => o.side === 'sell')
  const winCount = sells.filter((o) => o.realizedPnlUsd > 0).length
  const lossCount = sells.filter((o) => o.realizedPnlUsd < 0).length
  const realizedPnlUsd = sells.reduce((s, o) => s + o.realizedPnlUsd, 0)

  let peak = -Infinity
  let maxDrawdownPct = 0
  for (const point of portfolio.equityCurve) {
    peak = Math.max(peak, point.equityUsd)
    if (peak > 0) {
      maxDrawdownPct = Math.max(maxDrawdownPct, ((peak - point.equityUsd) / peak) * 100)
    }
  }

  return {
    equityUsd,
    totalPnlUsd: equityUsd - portfolio.initialUsd,
    totalPnlPct: ((equityUsd - portfolio.initialUsd) / portfolio.initialUsd) * 100,
    realizedPnlUsd,
    tradeCount: portfolio.orders.length,
    winCount,
    lossCount,
    winRatePct: sells.length > 0 ? (winCount / sells.length) * 100 : 0,
    maxDrawdownPct,
  }
}

/**
 * ラダールール評価（UC-5: 例 +100% で 50% 利確、-30% で損切り）。
 * 発動済みインデックスを除き、現在の損益率で新たに発動するルールを返す。
 * 呼び出し側は返却順（トリガー率の昇順）に順次執行し、triggered に追加して再入を防ぐ。
 */
export function checkLadder(
  entryPriceUsd: number,
  currentPriceUsd: number,
  rules: LadderRule[],
  triggered: number[],
): { index: number; rule: LadderRule }[] {
  if (entryPriceUsd <= 0) return []
  const pnlPct = ((currentPriceUsd - entryPriceUsd) / entryPriceUsd) * 100
  const fired: { index: number; rule: LadderRule }[] = []
  rules.forEach((rule, index) => {
    if (triggered.includes(index)) return
    const hit = rule.triggerPct >= 0 ? pnlPct >= rule.triggerPct : pnlPct <= rule.triggerPct
    if (hit) fired.push({ index, rule })
  })
  return fired.sort((a, b) => Math.abs(a.rule.triggerPct) - Math.abs(b.rule.triggerPct))
}

/** 既定のラダールール: +100%→50%利確 / +300%→残り50%利確 / -30%→全損切り */
export const DEFAULT_LADDER_RULES: LadderRule[] = [
  { triggerPct: 100, sellRatio: 0.5 },
  { triggerPct: 300, sellRatio: 0.5 },
  { triggerPct: -30, sellRatio: 1 },
]

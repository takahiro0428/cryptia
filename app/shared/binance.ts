import type { FlowPeriod } from './types'

/**
 * Binance 公開 API 連携（資金フロー実測・価格ストリーミング）。
 * - 資金フロー: kline のテイカー買い出来高から「実測の資金流入出（USD）」を算出する。
 *   テイカー買い（成行買い）が優勢 = 資金流入、テイカー売り優勢 = 流出という
 *   マーケットマイクロストラクチャの標準的な計測手法（CVD/ネットテイカーフロー）
 * - 価格: miniTicker WebSocket でサブ秒の価格更新を受信する
 */

/** 銘柄マスタ id → Binance シンボル（USDT 建て）。上場のない銘柄は null */
export const BINANCE_SYMBOLS: Record<string, string | null> = {
  bitcoin: 'BTCUSDT',
  ethereum: 'ETHUSDT',
  solana: 'SOLUSDT',
  ripple: 'XRPUSDT',
  binancecoin: 'BNBUSDT',
  cardano: 'ADAUSDT',
  dogecoin: 'DOGEUSDT',
  'avalanche-2': 'AVAXUSDT',
  chainlink: 'LINKUSDT',
  polkadot: 'DOTUSDT',
  tron: 'TRXUSDT',
  sui: 'SUIUSDT',
  'pax-gold': 'PAXGUSDT',
  // 以下は Binance 未上場（推定補完の対象）
  'tether-gold': null,
  'tesla-xstock': null,
  'nvidia-xstock': null,
  'apple-xstock': null,
  'sp500-xstock': null,
}

/** WebSocket シンボル（小文字）→ 銘柄 id の逆引き */
export const BINANCE_SYMBOL_TO_ASSET: Record<string, string> = Object.fromEntries(
  Object.entries(BINANCE_SYMBOLS)
    .filter((e): e is [string, string] => e[1] !== null)
    .map(([assetId, symbol]) => [symbol.toLowerCase(), assetId]),
)

/** 期間 → kline の取得パラメータ */
export const KLINE_PARAMS: Record<FlowPeriod, { interval: string; limit: number }> = {
  '1h': { interval: '5m', limit: 12 },
  '24h': { interval: '1h', limit: 24 },
  '7d': { interval: '1d', limit: 7 },
}

/**
 * kline 配列からネットテイカーフロー（USD）を算出する。
 * kline: [openTime, open, high, low, close, volume, closeTime,
 *         quoteVolume(7), trades, takerBuyBaseVol, takerBuyQuoteVol(10), ...]
 * ネットフロー = Σ(テイカー買い quote 出来高 − テイカー売り quote 出来高)
 *             = Σ(2 × takerBuyQuoteVol − quoteVolume)
 */
export function netTakerFlowUsd(klines: unknown[][]): number {
  let net = 0
  for (const k of klines) {
    const quoteVol = Number(k?.[7])
    const takerBuyQuote = Number(k?.[10])
    if (!Number.isFinite(quoteVol) || !Number.isFinite(takerBuyQuote)) continue
    net += 2 * takerBuyQuote - quoteVol
  }
  return net
}

/** miniTicker WebSocket メッセージの必要フィールド */
export interface MiniTicker {
  s: string // symbol
  c: string // close (現在値)
  o: string // open (24h 前)
}

/** miniTicker から価格・24h 騰落率を取り出す。不正データは null */
export function parseMiniTicker(data: unknown): { assetId: string; priceUsd: number; change24hPct: number } | null {
  const t = data as MiniTicker | undefined
  if (!t?.s || typeof t.c !== 'string') return null
  const assetId = BINANCE_SYMBOL_TO_ASSET[t.s.toLowerCase()]
  if (!assetId) return null
  const price = Number(t.c)
  const open = Number(t.o)
  if (!Number.isFinite(price) || price <= 0) return null
  const change24hPct = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0
  return { assetId, priceUsd: price, change24hPct }
}

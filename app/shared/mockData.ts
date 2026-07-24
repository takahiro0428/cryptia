import { ASSETS } from './assets'
import type { SolanaToken, Ticker } from './types'

/**
 * オフライン/デモ用モックデータ生成（決定論的擬似乱数）。
 * 外部 API 障害時のフォールバック（BR-5）とテストで使用する。
 * seed が同じなら常に同じ系列を返すため、テストが安定する。
 */

/** mulberry32 擬似乱数生成器 */
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a += 0x6d2b79f5
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const BASE_PRICES: Record<string, number> = {
  bitcoin: 118000,
  ethereum: 3600,
  solana: 186,
  ripple: 3.1,
  binancecoin: 720,
  cardano: 0.82,
  dogecoin: 0.24,
  'avalanche-2': 29,
  chainlink: 17.5,
  polkadot: 4.2,
  tron: 0.31,
  sui: 3.9,
  'pax-gold': 3350,
  'tether-gold': 3340,
  'tesla-xstock': 330,
  'nvidia-xstock': 172,
  'apple-xstock': 214,
  'sp500-xstock': 632,
}

const BASE_MCAP: Record<string, number> = {
  bitcoin: 2.3e12,
  ethereum: 4.4e11,
  solana: 9.9e10,
  ripple: 1.8e11,
  binancecoin: 1.0e11,
  cardano: 2.9e10,
  dogecoin: 3.6e10,
  'avalanche-2': 1.2e10,
  chainlink: 1.1e10,
  polkadot: 6.5e9,
  tron: 2.7e10,
  sui: 1.3e10,
  'pax-gold': 8.7e8,
  'tether-gold': 8.2e8,
  'tesla-xstock': 4.5e7,
  'nvidia-xstock': 6.2e7,
  'apple-xstock': 2.8e7,
  'sp500-xstock': 5.1e7,
}

/** 7日分（1時間刻み・168点）のランダムウォーク価格系列 */
export function mockSparkline(assetId: string, seed = 1): number[] {
  const random = rng(seed + hashCode(assetId))
  const base = BASE_PRICES[assetId] ?? 1
  const points: number[] = []
  let price = base * (0.92 + random() * 0.1)
  const drift = (random() - 0.45) * 0.002
  for (let i = 0; i < 168; i++) {
    price *= 1 + drift + (random() - 0.5) * 0.012
    points.push(price)
  }
  return points
}

function hashCode(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0
  return Math.abs(h)
}

/** 全銘柄のモックティッカー */
export function mockTickers(seed = 1, now = Date.now()): Ticker[] {
  return ASSETS.map((asset) => {
    const spark = mockSparkline(asset.id, seed)
    const last = spark[spark.length - 1]
    const pct = (back: number) => {
      const ref = spark[Math.max(0, spark.length - 1 - back)]
      return ref === 0 ? 0 : ((last - ref) / ref) * 100
    }
    const mcap = BASE_MCAP[asset.id] ?? 1e7
    const random = rng(seed + hashCode(asset.id) + 7)
    return {
      assetId: asset.id,
      priceUsd: last,
      change1hPct: pct(1),
      change24hPct: pct(24),
      change7dPct: pct(167),
      marketCapUsd: mcap,
      volume24hUsd: mcap * (0.02 + random() * 0.15),
      sparkline7d: spark,
      updatedAt: now,
    }
  })
}

const MOCK_TOKEN_NAMES: [string, string][] = [
  ['MOONCAT', 'Moon Cat'],
  ['SOLDOGE', 'Sol Doge'],
  ['PEPEKING', 'Pepe King'],
  ['GIGARAT', 'Giga Rat'],
  ['FROGWIF', 'Frog Wif Hat'],
  ['DARKLORD', 'Dark Lord'],
  ['BONKX', 'Bonk X'],
  ['SAMURAI', 'Samurai Inu'],
  ['NINJACAT', 'Ninja Cat'],
  ['VOIDPUP', 'Void Puppy'],
  ['MAGMA', 'Magma Coin'],
  ['ZENFROG', 'Zen Frog'],
]

/** Solana 草コインのモックリスト（DexScreener 障害時・デモ用） */
export function mockSolanaTokens(seed = 2, now = Date.now()): SolanaToken[] {
  const random = rng(seed)
  return MOCK_TOKEN_NAMES.map(([symbol, name], i) => {
    const liquidityUsd = 8_000 + random() * 900_000
    return {
      pairAddress: `MOCKPAIR${i}${symbol}`,
      baseSymbol: symbol,
      baseName: name,
      baseAddress: `MOCKMINT${i}${symbol}`,
      priceUsd: 10 ** (-6 + random() * 4),
      liquidityUsd,
      volume24hUsd: liquidityUsd * (0.05 + random() * 4),
      change24hPct: (random() - 0.35) * 400,
      ageHours: random() * 24 * 14,
      txns24h: Math.floor(random() * 6000),
      updatedAtMock: now,
    } as SolanaToken & { updatedAtMock?: number }
  })
}

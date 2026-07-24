import type { Asset } from './types'

/**
 * 銘柄マスタ（静的マスタ）。
 * id は CoinGecko coin id と一致させ、価格取得キーとしてそのまま使う。
 * 株式トークン・ゴールドトークンはトークン化資産の代表銘柄を採用。
 */
export const ASSETS: Asset[] = [
  { id: 'bitcoin', symbol: 'BTC', name: 'Bitcoin', nameJa: 'ビットコイン', class: 'crypto', color: '#f7931a' },
  { id: 'ethereum', symbol: 'ETH', name: 'Ethereum', nameJa: 'イーサリアム', class: 'crypto', color: '#627eea' },
  { id: 'solana', symbol: 'SOL', name: 'Solana', nameJa: 'ソラナ', class: 'crypto', color: '#14f195' },
  { id: 'ripple', symbol: 'XRP', name: 'XRP', nameJa: 'エックスアールピー', class: 'crypto', color: '#25a1e8' },
  { id: 'binancecoin', symbol: 'BNB', name: 'BNB', nameJa: 'ビーエヌビー', class: 'crypto', color: '#f0b90b' },
  { id: 'cardano', symbol: 'ADA', name: 'Cardano', nameJa: 'カルダノ', class: 'crypto', color: '#2a71d0' },
  { id: 'dogecoin', symbol: 'DOGE', name: 'Dogecoin', nameJa: 'ドージコイン', class: 'crypto', color: '#c2a633' },
  { id: 'avalanche-2', symbol: 'AVAX', name: 'Avalanche', nameJa: 'アバランチ', class: 'crypto', color: '#e84142' },
  { id: 'chainlink', symbol: 'LINK', name: 'Chainlink', nameJa: 'チェーンリンク', class: 'crypto', color: '#2a5ada' },
  { id: 'polkadot', symbol: 'DOT', name: 'Polkadot', nameJa: 'ポルカドット', class: 'crypto', color: '#e6007a' },
  { id: 'tron', symbol: 'TRX', name: 'TRON', nameJa: 'トロン', class: 'crypto', color: '#eb0029' },
  { id: 'sui', symbol: 'SUI', name: 'Sui', nameJa: 'スイ', class: 'crypto', color: '#4da2ff' },
  // トークン化ゴールド
  { id: 'pax-gold', symbol: 'PAXG', name: 'PAX Gold', nameJa: 'パックスゴールド', class: 'gold-token', color: '#d4af37' },
  { id: 'tether-gold', symbol: 'XAUT', name: 'Tether Gold', nameJa: 'テザーゴールド', class: 'gold-token', color: '#b8962e' },
  // トークン化株式（xStocks 系。CoinGecko 上場のトークン化株式）
  { id: 'tesla-xstock', symbol: 'TSLAX', name: 'Tesla xStock', nameJa: 'テスラ株トークン', class: 'stock-token', color: '#cc0000' },
  { id: 'nvidia-xstock', symbol: 'NVDAX', name: 'NVIDIA xStock', nameJa: 'エヌビディア株トークン', class: 'stock-token', color: '#76b900' },
  { id: 'apple-xstock', symbol: 'AAPLX', name: 'Apple xStock', nameJa: 'アップル株トークン', class: 'stock-token', color: '#a2aaad' },
  { id: 'sp500-xstock', symbol: 'SPYX', name: 'S&P 500 xStock', nameJa: 'S&P500トークン', class: 'stock-token', color: '#1f6feb' },
]

export const ASSET_MAP: Record<string, Asset> = Object.fromEntries(ASSETS.map((a) => [a.id, a]))

export function isKnownAssetId(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(ASSET_MAP, id)
}

export const ASSET_CLASS_LABELS: Record<Asset['class'], string> = {
  crypto: '仮想通貨',
  'stock-token': '株式トークン',
  'gold-token': 'ゴールド',
}

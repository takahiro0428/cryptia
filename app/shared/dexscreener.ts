import type { SolanaToken } from './types'

/**
 * DexScreener API の共有定義（クライアント直接取得・サーバープロキシ共用: 原則3）。
 * 本番でブラウザから api.dexscreener.com へ到達できない環境（企業ネットワーク・
 * 広告ブロッカー・地域制限等）があるため、クライアントは直接取得に失敗すると
 * 自アプリの /api/solana/* プロキシへフォールバックする。
 */

export const DEX_SEARCH_URL = 'https://api.dexscreener.com/latest/dex/search?q=SOL'
export const DEX_PAIRS_URL = 'https://api.dexscreener.com/latest/dex/pairs/solana/'
export const DEX_PROFILES_URL = 'https://api.dexscreener.com/token-profiles/latest/v1'
export const DEX_BOOSTS_URL = 'https://api.dexscreener.com/token-boosts/latest/v1'
export const DEX_TOKENS_URL = 'https://api.dexscreener.com/latest/dex/tokens/'
export const DEX_SEARCH_BASE = 'https://api.dexscreener.com/latest/dex/search?q='

/** DexScreener pair レスポンス（使用フィールドのみ） */
export interface DexPair {
  chainId?: string
  pairAddress?: string
  baseToken?: { address?: string; name?: string; symbol?: string }
  priceUsd?: string
  liquidity?: { usd?: number }
  volume?: { h24?: number }
  priceChange?: { h24?: number }
  txns?: { h24?: { buys?: number; sells?: number } }
  pairCreatedAt?: number
  info?: { websites?: { url?: string }[]; socials?: { type?: string; url?: string }[] }
}

/** DexScreener token-profiles レスポンス（使用フィールドのみ） */
export interface TokenProfile {
  chainId?: string
  tokenAddress?: string
  links?: { type?: string; label?: string; url?: string }[]
}

/** DexScreener token-boosts レスポンス（使用フィールドのみ） */
export interface TokenBoost {
  chainId?: string
  tokenAddress?: string
}

/** DexScreener pair → アプリ内トークン表現へ変換。不正データは null */
export function toToken(p: DexPair): SolanaToken | null {
  if (p.chainId !== 'solana' || !p.pairAddress || !p.baseToken?.address) return null
  const priceUsd = Number(p.priceUsd)
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return null
  const h24 = p.txns?.h24
  return {
    pairAddress: p.pairAddress,
    baseSymbol: (p.baseToken.symbol ?? '?').slice(0, 20),
    baseName: (p.baseToken.name ?? p.baseToken.symbol ?? '?').slice(0, 60),
    baseAddress: p.baseToken.address,
    priceUsd,
    liquidityUsd: p.liquidity?.usd ?? 0,
    volume24hUsd: p.volume?.h24 ?? 0,
    change24hPct: p.priceChange?.h24 ?? 0,
    ageHours: p.pairCreatedAt ? Math.max(0, (Date.now() - p.pairCreatedAt) / 3_600_000) : 0,
    txns24h: (h24?.buys ?? 0) + (h24?.sells ?? 0),
  }
}

/** ペア/ミントアドレスの形式検証（base58 英数のみ・長さ制限。プロキシの入力検証用） */
export function isValidAddress(addr: string): boolean {
  return /^[1-9A-HJ-NP-Za-km-z]{20,60}$/.test(addr)
}

/** token-profiles から辿る最大トークン数（tokens API は 30 件/回のため 2 バッチ分） */
export const FRESH_MAX_PROFILE_TOKENS = 60
/** 新規上場リストとして返す上位件数 */
export const FRESH_MAX_RESULTS = 12

export interface FreshDiscovery {
  mint: string
  pair: DexPair
  token: SolanaToken
  profile?: TokenProfile
}

/**
 * ミント群の関連ペアを一括解決する（tokens API は 30 件/回のためチャンク分割）。
 * バッチ単位の失敗は残りで継続する（原則4）。
 */
export async function fetchPairsForTokens(
  fetchJson: <T>(url: string) => Promise<T>,
  mints: string[],
  maxMints: number,
): Promise<DexPair[]> {
  const unique = [...new Set(mints.filter(isValidAddress))].slice(0, maxMints)
  const out: DexPair[] = []
  for (let i = 0; i < unique.length; i += 30) {
    try {
      const data = await fetchJson<{ pairs?: DexPair[] }>(
        `${DEX_TOKENS_URL}${unique.slice(i, i + 30).join(',')}`,
      )
      out.push(...(data.pairs ?? []))
    } catch {
      /* バッチ単位の失敗は残りで継続（原則4） */
    }
  }
  return out
}

/**
 * 同一ミントの複数プール（Raydium/Orca/Meteora 併存等）から
 * 最も流動性の高い代表ペアを 1 つ選ぶ。スクリーニング・おすすめ選定で
 * 同一トークンが複数枠を占有するのを防ぐ。
 */
export function bestPairPerMint(pairs: DexPair[]): DexPair[] {
  const best = new Map<string, DexPair>()
  for (const pair of pairs) {
    const mint = pair.baseToken?.address
    if (!mint) continue
    const current = best.get(mint)
    if (!current || (pair.liquidity?.usd ?? 0) > (current.liquidity?.usd ?? 0)) {
      best.set(mint, pair)
    }
  }
  return [...best.values()]
}

/**
 * スクリーニング用 Solana ペアの多ソース収集。
 * search?q=SOL は上流の応答構成やネットワーク環境によって Solana ペアが
 * 空になることがある（本番障害 CRYPTIA-E102「応答に Solana ペアがありません」の実例）ため、
 * token-boosts（宣伝中トークン）・token-profiles（掲載直後トークン）由来のペアで補完し、
 * 単一ソース依存を避ける。ソース単位の失敗は他ソースで継続する（原則4）。
 * 上流呼び出しは最大 5 回（search 1 + boosts 1 + profiles 1 + tokens バッチ 2）。
 */
export async function discoverScreeningPairs(
  fetchJson: <T>(url: string) => Promise<T>,
): Promise<DexPair[]> {
  const fromMintList = async (list: unknown): Promise<DexPair[]> => {
    const mints = (Array.isArray(list) ? (list as TokenBoost[]) : [])
      .filter((e) => e?.chainId === 'solana' && typeof e?.tokenAddress === 'string')
      .map((e) => e.tokenAddress as string)
    return fetchPairsForTokens(fetchJson, mints, 30)
  }
  const results = await Promise.allSettled([
    fetchJson<{ pairs?: DexPair[] }>(DEX_SEARCH_URL).then((d) => d.pairs ?? []),
    fetchJson<TokenBoost[]>(DEX_BOOSTS_URL).then(fromMintList),
    fetchJson<TokenProfile[]>(DEX_PROFILES_URL).then(fromMintList),
  ])
  const merged = new Map<string, DexPair>()
  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const p of r.value) {
      if (p.chainId === 'solana' && p.pairAddress && !merged.has(p.pairAddress)) {
        merged.set(p.pairAddress, p)
      }
    }
  }
  // トークン単位に代表プールへ集約（同一トークンがおすすめ枠を独占しない）
  return bestPairPerMint([...merged.values()])
}

/**
 * 新規上場トークンの発見パイプライン（サーバープロキシ・クライアント直接取得の共通処理）。
 * token-profiles（掲載直後のトークン）→ ミントごとに最も流動性の高いペアを解決 →
 * maxAgeHours 以内の新規ペアのみ・新しい順に上位を返す。
 * fetchJson を注入することで、実行環境ごとの取得手段（プロキシ/直接）を差し替える。
 */
export async function discoverFreshPairs(
  fetchJson: <T>(url: string) => Promise<T>,
  maxAgeHours: number,
): Promise<FreshDiscovery[]> {
  // 1) 掲載直後のトークンプロファイル（Solana のみ）
  const profiles = await fetchJson<TokenProfile[]>(DEX_PROFILES_URL)
  const profileByMint = new Map<string, TokenProfile>()
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (p.chainId !== 'solana' || !p.tokenAddress || !isValidAddress(p.tokenAddress)) continue
    if (!profileByMint.has(p.tokenAddress)) profileByMint.set(p.tokenAddress, p)
    if (profileByMint.size >= FRESH_MAX_PROFILE_TOKENS) break
  }
  const mints = [...profileByMint.keys()]

  // 2) ミント → 代表ペア（最も流動性の高いペア）解決
  const bestPair = new Map<string, DexPair>()
  const resolved = await fetchPairsForTokens(fetchJson, mints, FRESH_MAX_PROFILE_TOKENS)
  for (const pair of bestPairPerMint(resolved.filter((p) => p.chainId === 'solana'))) {
    bestPair.set(pair.baseToken!.address!, pair)
  }

  // 3) 指定時間内の新規ペアのみ・新しい順に上位を採用
  return [...bestPair.entries()]
    .map(([mint, pair]) => ({ mint, pair, token: toToken(pair), profile: profileByMint.get(mint) }))
    .filter((e): e is FreshDiscovery => e.token !== null)
    .filter((e) => e.token.ageHours <= maxAgeHours && e.token.liquidityUsd > 0)
    .sort((a, b) => a.token.ageHours - b.token.ageHours)
    .slice(0, FRESH_MAX_RESULTS)
}

/** pair.info と token-profile の links から SNS シグナルを抽出する */
export function extractSnsSignals(
  info: DexPair['info'],
  profileLinks?: TokenProfile['links'],
): { hasWebsite: boolean; hasTwitter: boolean; hasTelegram: boolean } {
  const urls: { type: string; url: string }[] = []
  for (const w of info?.websites ?? []) {
    if (w.url) urls.push({ type: 'website', url: w.url })
  }
  for (const s of info?.socials ?? []) {
    if (s.url) urls.push({ type: s.type ?? '', url: s.url })
  }
  for (const l of profileLinks ?? []) {
    if (l.url) urls.push({ type: l.type ?? l.label ?? '', url: l.url })
  }
  // URL 判定はホスト名の厳密比較で行う（"dropbox.com" が "x.com/" に部分一致する等の誤検出防止）
  const hostOf = (url: string): string => {
    try {
      return new URL(url).hostname.toLowerCase()
    } catch {
      return ''
    }
  }
  const isHost = (url: string, hosts: string[]): boolean => {
    const h = hostOf(url)
    return hosts.some((base) => h === base || h.endsWith(`.${base}`))
  }
  const has = (pred: (e: { type: string; url: string }) => boolean) => urls.some(pred)
  return {
    hasWebsite: has(
      (e) =>
        e.type.toLowerCase() === 'website' ||
        e.type.toLowerCase() === 'web' ||
        (!e.type && e.url.startsWith('http')),
    ),
    hasTwitter: has(
      (e) => e.type.toLowerCase() === 'twitter' || isHost(e.url, ['twitter.com', 'x.com']),
    ),
    hasTelegram: has(
      (e) => e.type.toLowerCase() === 'telegram' || isHost(e.url, ['t.me', 'telegram.me']),
    ),
  }
}

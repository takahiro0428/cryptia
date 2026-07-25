import { describe, expect, it } from 'vitest'
import {
  DEX_PROFILES_URL,
  discoverFreshPairs,
  extractSnsSignals,
  isValidAddress,
  toToken,
  type DexPair,
  type TokenProfile,
} from '~/shared/dexscreener'

const MINT_A = 'So11111111111111111111111111111111111111112'
const MINT_B = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'

function pair(overrides: Partial<DexPair> = {}): DexPair {
  return {
    chainId: 'solana',
    pairAddress: 'PAIR1111111111111111111111111111111111111',
    baseToken: { address: MINT_A, name: 'Alpha', symbol: 'ALPHA' },
    priceUsd: '0.5',
    liquidity: { usd: 20_000 },
    volume: { h24: 50_000 },
    priceChange: { h24: 10 },
    txns: { h24: { buys: 100, sells: 50 } },
    pairCreatedAt: Date.now() - 2 * 3_600_000,
    ...overrides,
  }
}

describe('dexscreener: 変換と検証', () => {
  it('正常なペアをトークンへ変換する', () => {
    const t = toToken(pair())
    expect(t).not.toBeNull()
    expect(t!.baseSymbol).toBe('ALPHA')
    expect(t!.priceUsd).toBe(0.5)
    expect(t!.txns24h).toBe(150)
    expect(t!.ageHours).toBeGreaterThan(1.9)
  })

  it('solana 以外・価格不正・アドレス欠落は null', () => {
    expect(toToken(pair({ chainId: 'ethereum' }))).toBeNull()
    expect(toToken(pair({ priceUsd: '0' }))).toBeNull()
    expect(toToken(pair({ priceUsd: 'abc' }))).toBeNull()
    expect(toToken(pair({ baseToken: undefined }))).toBeNull()
  })

  it('アドレス形式検証（base58・長さ）', () => {
    expect(isValidAddress(MINT_A)).toBe(true)
    expect(isValidAddress('short')).toBe(false)
    expect(isValidAddress('has space in it aaaaaaaaaaaaaaaaaaaa')).toBe(false)
    // base58 に存在しない文字（0, O, I, l）
    expect(isValidAddress('0OIl000000000000000000000000000000000000')).toBe(false)
  })

  it('SNS シグナルを pair.info と profile links の両方から抽出する', () => {
    const fromInfo = extractSnsSignals({
      websites: [{ url: 'https://example.com' }],
      socials: [{ type: 'twitter', url: 'https://x.com/example' }],
    })
    expect(fromInfo).toEqual({ hasWebsite: true, hasTwitter: true, hasTelegram: false })

    const fromProfile = extractSnsSignals(undefined, [
      { label: 'Website', type: 'website', url: 'https://example.com' },
      { type: 'telegram', url: 'https://t.me/example' },
    ])
    expect(fromProfile.hasWebsite).toBe(true)
    expect(fromProfile.hasTelegram).toBe(true)
    expect(fromProfile.hasTwitter).toBe(false)

    expect(extractSnsSignals(undefined, undefined)).toEqual({
      hasWebsite: false,
      hasTwitter: false,
      hasTelegram: false,
    })
  })

  it('X/Telegram の URL 判定はホスト名の厳密比較（部分一致で誤検出しない）', () => {
    const fake = extractSnsSignals({
      socials: [
        { type: 'other', url: 'https://dropbox.com/x.com/page' },
        { type: 'other', url: 'https://notx.com/profile' },
        { type: 'other', url: 'https://example.com/t.me/abc' },
      ],
    })
    expect(fake.hasTwitter).toBe(false)
    expect(fake.hasTelegram).toBe(false)

    const real = extractSnsSignals({
      socials: [
        { type: 'other', url: 'https://x.com/project' },
        { type: 'other', url: 'https://t.me/project' },
      ],
    })
    expect(real.hasTwitter).toBe(true)
    expect(real.hasTelegram).toBe(true)
  })
})

describe('dexscreener: 新規上場発見パイプライン', () => {
  it('プロファイル → 最良ペア解決 → 年齢で絞り込み・新しい順', async () => {
    const profiles: TokenProfile[] = [
      { chainId: 'solana', tokenAddress: MINT_A, links: [{ type: 'twitter', url: 'https://x.com/a' }] },
      { chainId: 'solana', tokenAddress: MINT_B },
      { chainId: 'ethereum', tokenAddress: MINT_B }, // 他チェーンは除外
    ]
    const pairsByMint: DexPair[] = [
      // MINT_A: 流動性の異なる2ペア → 高い方が代表になる
      pair({ pairAddress: 'PAIRa111111111111111111111111111111111111', liquidity: { usd: 5_000 } }),
      pair({ pairAddress: 'PAIRa222222222222222222222222222222222222', liquidity: { usd: 40_000 } }),
      // MINT_B: 古すぎる（96h）→ 除外
      pair({
        pairAddress: 'PAIRb111111111111111111111111111111111111',
        baseToken: { address: MINT_B, name: 'Beta', symbol: 'BETA' },
        pairCreatedAt: Date.now() - 96 * 3_600_000,
      }),
    ]
    const fetchJson = async <T>(url: string): Promise<T> => {
      if (url === DEX_PROFILES_URL) return profiles as T
      return { pairs: pairsByMint } as T
    }
    const discovered = await discoverFreshPairs(fetchJson, 48)
    expect(discovered).toHaveLength(1)
    expect(discovered[0].mint).toBe(MINT_A)
    expect(discovered[0].pair.pairAddress).toBe('PAIRa222222222222222222222222222222222222')
    expect(discovered[0].profile?.links?.[0]?.type).toBe('twitter')
  })

  it('ペア解決バッチが失敗しても例外にせず空リストで返す（原則4）', async () => {
    const fetchJson = async <T>(url: string): Promise<T> => {
      if (url === DEX_PROFILES_URL) {
        return [{ chainId: 'solana', tokenAddress: MINT_A }] as T
      }
      throw new Error('batch failed')
    }
    await expect(discoverFreshPairs(fetchJson, 48)).resolves.toEqual([])
  })
})

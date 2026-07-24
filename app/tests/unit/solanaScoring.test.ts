import { describe, expect, it } from 'vitest'
import { isTradable, rankTokens, scoreToken } from '~/shared/solanaScoring'
import type { SolanaToken } from '~/shared/types'

function token(overrides: Partial<SolanaToken> = {}): SolanaToken {
  return {
    pairAddress: 'PAIR1',
    baseSymbol: 'TEST',
    baseName: 'Test Token',
    baseAddress: 'MINT1',
    priceUsd: 0.001,
    liquidityUsd: 200_000,
    volume24hUsd: 300_000,
    change24hPct: 20,
    ageHours: 24 * 5,
    txns24h: 2000,
    ...overrides,
  }
}

describe('Solana トークンスコアリング（shared/solanaScoring）', () => {
  it('スコアは 0-100 の範囲', () => {
    const s = scoreToken(token())
    expect(s.total).toBeGreaterThanOrEqual(0)
    expect(s.total).toBeLessThanOrEqual(100)
  })

  it('流動性 $50k 未満は警告が付き取引不適格になる', () => {
    const s = scoreToken(token({ liquidityUsd: 10_000 }))
    expect(s.warnings.some((w) => w.includes('流動性'))).toBe(true)
    expect(isTradable(s)).toBe(false)
  })

  it('ペア年齢 24h 未満は警告が付き取引不適格になる', () => {
    const s = scoreToken(token({ ageHours: 3 }))
    expect(s.warnings.some((w) => w.includes('24 時間未満'))).toBe(true)
    expect(isTradable(s)).toBe(false)
  })

  it('+300% 超の垂直上昇は過熱警告', () => {
    const s = scoreToken(token({ change24hPct: 400 }))
    expect(s.warnings.some((w) => w.includes('垂直上昇'))).toBe(true)
  })

  it('健全なトークンは高スコア・適格', () => {
    const s = scoreToken(
      token({ liquidityUsd: 1_000_000, volume24hUsd: 2_000_000, change24hPct: 30, ageHours: 24 * 10 }),
    )
    expect(s.total).toBeGreaterThanOrEqual(55)
    expect(isTradable(s)).toBe(true)
  })

  it('rankTokens: 適格トークンが先頭に来る', () => {
    const good = token({ pairAddress: 'GOOD', liquidityUsd: 800_000, ageHours: 24 * 7 })
    const bad = token({ pairAddress: 'BAD', liquidityUsd: 5_000, ageHours: 2 })
    const ranked = rankTokens([bad, good])
    expect(ranked[0].token.pairAddress).toBe('GOOD')
  })
})

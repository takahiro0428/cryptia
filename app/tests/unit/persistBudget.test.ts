import { describe, expect, it } from 'vitest'
import { fitArchivesToBudget, utf8Bytes } from '~/shared/persistBudget'

interface Arch {
  id: number
  orders?: { reason: string }[]
}

/** テスト用: アーカイブ列のみのペイロードのバイト数 */
const measure = (archives: Arch[]) => utf8Bytes(JSON.stringify({ archives }))

function arch(id: number, orderCount: number, reasonLen = 100): Arch {
  return {
    id,
    orders: Array.from({ length: orderCount }, () => ({ reason: 'あ'.repeat(reasonLen) })),
  }
}

describe('persistBudget: 保存容量の実測保証', () => {
  it('utf8Bytes はマルチバイト文字を実バイト数で数える', () => {
    expect(utf8Bytes('abc')).toBe(3)
    expect(utf8Bytes('あ')).toBe(3) // 日本語は UTF-8 で 3 バイト
  })

  it('予算内ならそのまま返す（切り詰めなし）', () => {
    const archives = [arch(1, 2), arch(2, 2)]
    const result = fitArchivesToBudget(archives, measure, 100_000)
    expect(result).toBe(archives)
    expect(result[0].orders).toHaveLength(2)
  })

  it('超過時は古いアーカイブの orders から落とす（新しい方は保持）', () => {
    // 1 アーカイブ ≈ 100件 × 300バイト超。予算をアーカイブ 1.5 件分に設定
    const archives = [arch(1, 100), arch(2, 100), arch(3, 100)]
    const budget = Math.floor(measure([arch(1, 100)]) * 1.5)
    const result = fitArchivesToBudget(archives, measure, budget)
    expect(measure(result)).toBeLessThanOrEqual(budget)
    // 最新（先頭）の明細が最後まで保持される
    expect(result[0].orders?.length).toBe(100)
    // サマリー行（アーカイブ自体）は全件残る
    expect(result.map((a) => a.id)).toEqual([1, 2, 3])
    expect(result[2].orders).toBeUndefined()
  })

  it('全明細を落としても超過する場合は古いアーカイブごと落とす（最新1件は必ず残す）', () => {
    const archives = [arch(1, 100), arch(2, 0), arch(3, 0)]
    // 明細なしアーカイブ 1 件分より小さい極端な予算
    const result = fitArchivesToBudget(archives, measure, 10)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe(1)
  })

  it('元の配列を破壊しない（イミュータブル）', () => {
    const archives = [arch(1, 50), arch(2, 50)]
    fitArchivesToBudget(archives, measure, 100)
    expect(archives[1].orders).toHaveLength(50)
  })
})

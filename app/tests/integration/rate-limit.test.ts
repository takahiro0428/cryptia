import { describe, expect, it } from 'vitest'
import {
  consumeToken,
  MAX_BUCKETS,
  pruneBuckets,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from '~/server/utils/rateLimit'

/**
 * 結合テスト: AI API レートリミッタ（AUDIT-2 対策）。
 */
describe('AI API レートリミッタ', () => {
  it('ウィンドウ内は上限まで許可し、超過を拒否する', () => {
    const key = 'ip-test-1'
    const now = 1_000_000
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      expect(consumeToken(key, now + i)).toBe(true)
    }
    expect(consumeToken(key, now + RATE_LIMIT_MAX)).toBe(false)
  })

  it('ウィンドウ経過後はリセットされる', () => {
    const key = 'ip-test-2'
    const now = 2_000_000
    for (let i = 0; i < RATE_LIMIT_MAX; i++) consumeToken(key, now)
    expect(consumeToken(key, now)).toBe(false)
    expect(consumeToken(key, now + RATE_LIMIT_WINDOW_MS)).toBe(true)
  })

  it('キー（IP）ごとに独立してカウントされる', () => {
    const now = 3_000_000
    for (let i = 0; i < RATE_LIMIT_MAX; i++) consumeToken('ip-a', now)
    expect(consumeToken('ip-a', now)).toBe(false)
    expect(consumeToken('ip-b', now)).toBe(true)
  })

  it('pruneBuckets: 期限切れバケットを掃除してもカウント動作に影響しない', () => {
    const now = 4_000_000
    consumeToken('ip-old', now)
    pruneBuckets(now + RATE_LIMIT_WINDOW_MS * 3)
    // 掃除後は新規ウィンドウとして扱われる
    expect(consumeToken('ip-old', now + RATE_LIMIT_WINDOW_MS * 3)).toBe(true)
  })

  it('キー偽装によるバケット無限増加はフェイルクローズで抑止される（AUDIT-10 回帰）', () => {
    const now = 5_000_000
    // ウィンドウ内で MAX_BUCKETS まで異なるキーを消費
    for (let i = 0; i < MAX_BUCKETS; i++) {
      consumeToken(`spoofed-${i}`, now)
    }
    // 期限切れが存在しない状態での新規キーは拒否される（メモリ枯渇防止）
    expect(consumeToken('spoofed-overflow', now)).toBe(false)
    // ウィンドウ経過後は掃除されて受け付ける
    expect(consumeToken('spoofed-overflow', now + RATE_LIMIT_WINDOW_MS * 2 + 1)).toBe(true)
  })
})

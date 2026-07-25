import { describe, expect, it } from 'vitest'
import { METHOD_VALIDATORS } from '~/server/api/solana/rpc.post'

/**
 * RPC プロキシのメソッド別バリデータ（F-13 で送信系を追加）。
 * オープンプロキシ化・プロトタイプ迂回・不正オプションの遮断を検証する。
 */

const ADDR = 'FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCyxx'.slice(0, 44)
const SIG = '5'.repeat(87)

describe('rpcProxy: メソッド別バリデータ', () => {
  it('未許可メソッド・プロトタイプ由来のキーは解決されない', () => {
    expect(METHOD_VALIDATORS['getAccountInfo']).toBeUndefined()
    expect(METHOD_VALIDATORS['requestAirdrop']).toBeUndefined()
    // Object.create(null) のため継承プロパティが許可リストを通過しない
    expect(METHOD_VALIDATORS['constructor']).toBeUndefined()
    expect(METHOD_VALIDATORS['toString']).toBeUndefined()
    expect(METHOD_VALIDATORS['hasOwnProperty']).toBeUndefined()
  })

  it('sendTransaction: base64 のみ・サイズ上限・オプションは許可キーのみ', () => {
    const v = METHOD_VALIDATORS['sendTransaction']
    expect(v(['QUJDRA=='])).toBe(true)
    expect(v(['QUJDRA==', { encoding: 'base64', maxRetries: 3 }])).toBe(true)
    expect(v([''])).toBe(false) // 空
    expect(v(['not base64!!'])).toBe(false) // 記号混入
    expect(v(['A'.repeat(3_001)])).toBe(false) // サイズ超過
    expect(v(['QUJDRA==', { encoding: 'base58' }])).toBe(false) // base64 以外
    expect(v(['QUJDRA==', { skipPreflight: true }])).toBe(false) // preflight 無効化は拒否
    expect(v(['QUJDRA==', { maxRetries: 100 }])).toBe(false) // 値域超過
    expect(v(['QUJDRA==', { unknown: 1 }])).toBe(false) // 未知キー
  })

  it('getLatestBlockhash: 引数なし or commitment のみ', () => {
    const v = METHOD_VALIDATORS['getLatestBlockhash']
    expect(v([])).toBe(true)
    expect(v([{ commitment: 'finalized' }])).toBe(true)
    expect(v([{ commitment: 'bogus' }])).toBe(false)
    expect(v([{ minContextSlot: 1 }])).toBe(false)
    expect(v([{}, {}])).toBe(false)
  })

  it('getSignatureStatuses: base58 署名の配列（1〜10件）のみ', () => {
    const v = METHOD_VALIDATORS['getSignatureStatuses']
    expect(v([[SIG]])).toBe(true)
    expect(v([[SIG], { searchTransactionHistory: false }])).toBe(true)
    expect(v([[]])).toBe(false)
    expect(v([Array.from({ length: 11 }, () => SIG)])).toBe(false)
    expect(v([['not-a-signature!']])).toBe(false)
    expect(v([[SIG], { searchTransactionHistory: 'yes' }])).toBe(false)
  })

  it('読み取り系: アドレス検証は従来どおり', () => {
    expect(METHOD_VALIDATORS['getBalance']([ADDR])).toBe(true)
    expect(METHOD_VALIDATORS['getBalance'](['bad address'])).toBe(false)
    expect(METHOD_VALIDATORS['getTokenAccountsByOwner']([ADDR, { mint: ADDR }, { encoding: 'jsonParsed' }])).toBe(true)
  })
})

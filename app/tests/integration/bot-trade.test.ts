import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import {
  b64ToBytes,
  bytesToB64,
  bytesToBase58,
  decryptSecretKey,
  encryptSecretKey,
} from '~/shared/botKeyStore'
import { scoreFreshToken, type FreshTokenSignals, type SnipeScore } from '~/shared/snipeScoring'
import type { SolanaToken } from '~/shared/types'
import { sellPortionRaw, useBotTradeStore } from '~/stores/botTrade'
import { useSolanaStore } from '~/stores/solana'
import { useWalletStore } from '~/stores/wallet'

/**
 * ボットウォレット自動実行（F-13）の結合テスト。
 * ネットワーク（Jupiter / RPC）はストアメソッドの差し替えでモックし、
 * 鍵の暗号化・エントリーゲート・SOL 建て上限・出口ラダー・出金ガードを検証する。
 */

const OWNER = 'FvwEAhmxKfeiG8SnEvq42hc6whRyY3EFYAvebMqDNDGCyxx'.slice(0, 44)

let seq = 0
function freshScore(tokenOverrides: Partial<SolanaToken> = {}): SnipeScore {
  seq++
  // アドレスは base58 有効文字のみで生成する（0/O/I/l は base58 に存在しない）
  const B58_LETTERS = 'abcdefghijkmnopqrstuvwxyz' // 'l' を除く 25 文字
  const tag = B58_LETTERS[seq % 25]! + B58_LETTERS[Math.floor(seq / 25) % 25]!
  const token: SolanaToken = {
    pairAddress: `Apair${tag}${'1'.repeat(37)}`.slice(0, 44),
    baseSymbol: `BOT${seq}`,
    baseName: `Bot Token ${seq}`,
    baseAddress: `Amint${tag}${'2'.repeat(37)}`.slice(0, 44),
    priceUsd: 0.001,
    liquidityUsd: 30_000,
    volume24hUsd: 100_000,
    change24hPct: 20,
    ageHours: 3,
    txns24h: 500,
    ...tokenOverrides,
  }
  const signals: FreshTokenSignals = {
    hasWebsite: true,
    hasTwitter: true,
    hasTelegram: true,
    mintAuthorityRenounced: true,
    freezeAuthorityAbsent: true,
    duplicateCount: 0,
    buys24h: 300,
    sells24h: 100,
  }
  return scoreFreshToken(token, signals)
}

/** ボットストアを解除済み・ネットワークモック済みでセットアップする */
async function setupBot(scores: SnipeScore[], opts: { balanceSol?: number; priceImpact?: string } = {}) {
  const bot = useBotTradeStore()
  const solana = useSolanaStore()
  const wallet = useWalletStore()
  await bot.createWallet('passphrase123', OWNER)
  bot.balanceSol = opts.balanceSol ?? 1
  bot.refreshBalance = vi.fn(async () => {}) // 残高はテストで固定
  bot.setConfig({ riskConsentAt: Date.now(), entrySol: 0.05, maxPositions: 2, dailyMaxSol: 0.5 })
  bot.running = true // タイマーは使わず tick を直接呼ぶ
  solana.usingMockData = false
  solana.freshFetchedAt = Date.now()
  solana.freshTokens = scores
  solana.freshSeenAt = Object.fromEntries(scores.map((s) => [s.token.pairAddress, Date.now()]))
  // Jupiter 見積り・署名送信・価格取得をモック
  const quotes: unknown[] = []
  wallet.getQuoteRaw = vi.fn(async (inputMint: string, outputMint: string, amountRaw: string) => {
    const q = {
      inputMint,
      outputMint,
      inAmount: amountRaw,
      outAmount: inputMint === 'So11111111111111111111111111111111111111112' ? '1000000000' : '70000000',
      priceImpactPct: opts.priceImpact ?? '0.5',
    }
    quotes.push(q)
    return q
  })
  const sends: unknown[] = []
  bot._signAndSend = vi.fn(async (quote: unknown) => {
    sends.push(quote)
    return `txid-${sends.length}`
  })
  // オンチェーン確定は既定で成功、実残高照合は既定で「取得不可 = 計算値フォールバック」
  bot._confirmTx = vi.fn(async () => true)
  bot._actualBalanceRaw = vi.fn(async () => null)
  return { bot, solana, wallet, quotes, sends }
}

describe('botKeyStore: 鍵の暗号化保管', () => {
  it('暗号化 → 正しいパスフレーズで復号できる（ラウンドトリップ）', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(64))
    const enc = await encryptSecretKey(secret, 'correct horse battery')
    const dec = await decryptSecretKey(enc, 'correct horse battery')
    expect([...dec]).toEqual([...secret])
    // 暗号文に平文が含まれない
    expect(enc.data).not.toBe(bytesToB64(secret))
  })

  it('誤ったパスフレーズは復号失敗（GCM 認証）', async () => {
    const enc = await encryptSecretKey(new Uint8Array(64).fill(7), 'right-pass-123')
    await expect(decryptSecretKey(enc, 'wrong-pass-456')).rejects.toThrow()
  })

  it('8 文字未満のパスフレーズは拒否する', async () => {
    await expect(encryptSecretKey(new Uint8Array(64), 'short')).rejects.toThrow()
  })

  it('base64 / base58 の相互変換が正しい', () => {
    const bytes = new Uint8Array([0, 0, 255, 1, 128, 60])
    expect([...b64ToBytes(bytesToB64(bytes))]).toEqual([...bytes])
    expect(bytesToBase58(new Uint8Array([0, 0, 1]))).toBe('112')
  })
})

describe('botTrade: sellPortionRaw（BigInt の数量配分）', () => {
  it('比率 1 は全量、端数は切り捨て、大きな raw でも精度を保つ', () => {
    expect(sellPortionRaw('1000', 1)).toBe('1000')
    expect(sellPortionRaw('1000', 0.7)).toBe('700')
    expect(sellPortionRaw('999999999999999999', 0.5)).toBe('499999999999999999')
    expect(sellPortionRaw('3', 0.7)).toBe('2')
  })
})

describe('botTrade: 自動実行エンジン', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    localStorage.clear()
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  })

  it('監査通過トークンへ SOL 建てでエントリーし、ポジション・日次消費・履歴を記録する', async () => {
    const good = freshScore()
    const { bot, sends } = await setupBot([good])
    await bot.tick()
    expect(sends).toHaveLength(1)
    expect(bot.positions).toHaveLength(1)
    expect(bot.positions[0].mint).toBe(good.token.baseAddress)
    expect(bot.positions[0].amountRaw).toBe('1000000000')
    expect(bot.positions[0].entrySol).toBe(0.05)
    expect(bot.todaysSpentSol).toBeCloseTo(0.05, 10)
    expect(bot.enteredMints).toContain(good.token.baseAddress)
    expect(bot.log[0].side).toBe('buy')
    expect(bot.log[0].txid).toBe('txid-1')
  })

  it('1日の投入上限（SOL）に達したらエントリーしない', async () => {
    const { bot, sends } = await setupBot([freshScore(), freshScore()])
    bot.dailySpent = { day: new Date().toISOString().slice(0, 10), sol: 0.48 }
    await bot.tick()
    expect(sends).toHaveLength(0) // 0.48 + 0.05 > 0.5
    expect(bot.positions).toHaveLength(0)
  })

  it('残高不足（手数料予約分を含む）ではエントリーしない', async () => {
    const { bot, sends } = await setupBot([freshScore()], { balanceSol: 0.05 })
    await bot.tick()
    expect(sends).toHaveLength(0) // 0.05 < entry 0.05 + 予約 0.01
  })

  it('価格影響が大きすぎる見積りは執行しない（板の薄い銘柄の回避）', async () => {
    const { bot, sends } = await setupBot([freshScore()], { priceImpact: '15' })
    await bot.tick()
    expect(sends).toHaveLength(0)
    expect(bot.positions).toHaveLength(0)
  })

  it('参考データ（モック）中・監視データが古い間はエントリーしない', async () => {
    const first = await setupBot([freshScore()])
    first.solana.usingMockData = true
    await first.bot.tick()
    expect(first.bot.positions).toHaveLength(0)

    setActivePinia(createPinia())
    localStorage.clear()
    const second = await setupBot([freshScore()])
    second.solana.freshFetchedAt = Date.now() - 10 * 60 * 1000
    await second.bot.tick()
    expect(second.bot.positions).toHaveLength(0)
  })

  it('ムーンバッグ戦略: +100% で 70% 売却しムーンバッグ化、以後は損切りも発火しない', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const { bot } = await setupBot([good])
    await bot.tick() // エントリー（amountRaw = 1000000000）
    const position = bot.positions[0]

    // 価格 2 倍を返すようにして出口ティック
    bot._fetchPositionPrices = vi.fn(async () => ({ [position.pairAddress]: 0.002 }))
    useSolanaStore().freshTokens = [] // 追加エントリーを止める
    await bot.tick()
    expect(position.amountRaw).toBe(String(1000000000 - 700000000))
    expect(position.moonbagAt).toBeDefined()
    expect(bot.log[0].side).toBe('sell')
    expect(bot.log[0].reason).toContain('ムーンバッグ利確')

    // -60% でも売却されない（完全放置）
    bot._fetchPositionPrices = vi.fn(async () => ({ [position.pairAddress]: 0.0004 }))
    const logCount = bot.log.length
    await bot.tick()
    expect(bot.log).toHaveLength(logCount)
    expect(bot.positions).toHaveLength(1)
  })

  it('ムーンバッグ戦略: +100% 未到達の損切りは全量決済してポジションを閉じる', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const { bot } = await setupBot([good])
    await bot.tick()
    const pair = bot.positions[0].pairAddress

    bot._fetchPositionPrices = vi.fn(async () => ({ [pair]: 0.00045 })) // -55%
    useSolanaStore().freshTokens = []
    await bot.tick()
    expect(bot.positions).toHaveLength(0)
    expect(bot.log[0].side).toBe('sell')
    expect(bot.log[0].reason).toContain('損切り')
    // 全決済後も再エントリーは防止される
    expect(bot.enteredMints).toContain(good.token.baseAddress)
  })

  it('買い Tx がオンチェーンで失敗（err）したらポジションを作らない（日次消費は安全側で計上）', async () => {
    const { bot } = await setupBot([freshScore()])
    bot._confirmTx = vi.fn(async () => false)
    await bot.tick()
    expect(bot.positions).toHaveLength(0)
    expect(bot.todaysSpentSol).toBeCloseTo(0.05, 10) // 安全側: 上限は早く締まる方向
    expect(bot.log[0].reason).toContain('ポジション未成立')
  })

  it('売却 Tx が確定しない場合は triggered を進めず次ティックで再試行する', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const { bot } = await setupBot([good])
    await bot.tick()
    const position = bot.positions[0]
    useSolanaStore().freshTokens = []
    bot._fetchPositionPrices = vi.fn(async () => ({ [position.pairAddress]: 0.002 }))

    bot._confirmTx = vi.fn(async () => null) // タイムアウト（不明）
    await bot.tick()
    expect(position.triggered).toHaveLength(0) // 進めない
    expect(position.moonbagAt).toBeUndefined()

    bot._confirmTx = vi.fn(async () => true) // 次ティックで確定 → 進む
    await bot.tick()
    expect(position.moonbagAt).toBeDefined()
  })

  it('全量売却（損切り）は実残高で執行し、実残高ゼロの幻ポジションは除去される', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const { bot, quotes } = await setupBot([good])
    await bot.tick()
    const position = bot.positions[0]
    useSolanaStore().freshTokens = []
    bot._fetchPositionPrices = vi.fn(async () => ({ [position.pairAddress]: 0.00045 })) // -55%

    // スリッページで実残高が追跡数量より少ないケース → 実残高で全量売却
    bot._actualBalanceRaw = vi.fn(async () => '970000000')
    await bot.tick()
    expect(bot.positions).toHaveLength(0)
    const sellQuote = quotes[quotes.length - 1] as { inAmount: string }
    expect(sellQuote.inAmount).toBe('970000000')

    // 幻ポジション（買い Tx ドロップ = 実残高 0）は売却せず記録から除去
    setActivePinia(createPinia())
    localStorage.clear()
    const second = await setupBot([freshScore({ priceUsd: 0.001 })])
    await second.bot.tick()
    const ghost = second.bot.positions[0]
    useSolanaStore().freshTokens = []
    second.bot._fetchPositionPrices = vi.fn(async () => ({ [ghost.pairAddress]: 0.0004 }))
    second.bot._actualBalanceRaw = vi.fn(async () => '0')
    const sellCountBefore = (second.bot._signAndSend as ReturnType<typeof vi.fn>).mock.calls.length
    await second.bot.tick()
    expect(second.bot.positions).toHaveLength(0)
    expect((second.bot._signAndSend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sellCountBefore)
  })

  it('確認タイムアウト後の部分売却再試行: 実残高が執行後相当なら二重売却せず段を確定する', async () => {
    const good = freshScore({ priceUsd: 0.001 })
    const { bot } = await setupBot([good])
    await bot.tick() // エントリー（amountRaw = 1000000000）
    const position = bot.positions[0]
    useSolanaStore().freshTokens = []
    bot._fetchPositionPrices = vi.fn(async () => ({ [position.pairAddress]: 0.002 }))
    // 前回の 70% 売却が着地済み（実残高 = 30% 相当）だが確認タイムアウトで triggered 未進行の状態
    bot._actualBalanceRaw = vi.fn(async () => '300000000')
    const sellsBefore = (bot._signAndSend as ReturnType<typeof vi.fn>).mock.calls.length
    await bot.tick()
    // 二重売却は送信されず、段が確定してムーンバッグ化・追跡数量は実残高へ同期
    expect((bot._signAndSend as ReturnType<typeof vi.fn>).mock.calls.length).toBe(sellsBefore)
    expect(position.moonbagAt).toBeDefined()
    expect(position.amountRaw).toBe('300000000')
    // 着地済み売却は追記型ログに記録される（BR-7: ISSUE-P9-L41）
    expect(bot.log[0].side).toBe('sell')
    expect(bot.log[0].reason).toContain('実残高照合で確認')
  })

  it('日次上限は日付が変わるとリセットされる（UTC 基準）', async () => {
    const { bot, sends } = await setupBot([freshScore()])
    bot.dailySpent = { day: '2000-01-01', sol: 99 } // 過去日の消費は無効
    expect(bot.todaysSpentSol).toBe(0)
    await bot.tick()
    expect(sends).toHaveLength(1)
    expect(bot.dailySpent.sol).toBeCloseTo(0.05, 10)
  })

  it('破損・改竄された保存状態は復元時に検証で除外される（SOL 建て上限の NaN バイパス防止）', async () => {
    const bot = useBotTradeStore()
    await bot.createWallet('passphrase123', OWNER)
    // 改竄された状態を直接保存
    const { saveLocal } = await import('~/composables/usePersistence')
    saveLocal('bot-trade-state', {
      config: { strategy: 'evil', entrySol: 'NaN', dailyMaxSol: '100', riskConsentAt: 'yes' },
      positions: [
        { mint: 'x', pairAddress: 'y', amountRaw: 'not-a-number', entryPriceUsd: 1, triggered: [] },
        { mint: 'ok', pairAddress: 'ok', amountRaw: '100', entryPriceUsd: Number.NaN, triggered: [] },
      ],
      enteredMints: ['a', 42, null],
      log: 'broken',
      dailySpent: { day: '2026-01-01', sol: 'NaN' },
    })
    setActivePinia(createPinia())
    const restored = useBotTradeStore()
    restored.restoreState()
    expect(restored.config.strategy).toBe('moonbag') // 不正値は既定へ
    expect(Number.isFinite(restored.config.entrySol)).toBe(true)
    expect(restored.config.dailyMaxSol).toBe(0.5)
    expect(restored.config.riskConsentAt).toBeNull()
    expect(restored.positions).toHaveLength(0) // 不正ポジションは除外
    expect(restored.enteredMints).toEqual(['a'])
    expect(restored.log).toEqual([])
    expect(Number.isFinite(restored.todaysSpentSol)).toBe(true)
  })

  it('AAD 束縛: 出金先アドレスを書き換えると解除（復号）が失敗する', async () => {
    const bot = useBotTradeStore()
    await bot.createWallet('passphrase123', OWNER)
    bot.lock()
    // localStorage の StoredKey.ownerAddress を直接すり替え
    const raw = localStorage.getItem('cryptia:bot-wallet-key')!
    const stored = JSON.parse(raw) as { data: { ownerAddress: string } }
    stored.data.ownerAddress = 'Attacker11111111111111111111111111111111111'.slice(0, 44)
    localStorage.setItem('cryptia:bot-wallet-key', JSON.stringify(stored))
    setActivePinia(createPinia())
    const tampered = useBotTradeStore()
    tampered.restoreState()
    await expect(tampered.unlock('passphrase123')).rejects.toThrow(/改竄/)
  })

  it('出金: 全額はちょうど残高-手数料、rent 未満の端数が残る部分出金は拒否、実行中は拒否', async () => {
    const bot = useBotTradeStore()
    await bot.createWallet('passphrase123', OWNER)
    bot.refreshBalance = vi.fn(async () => {})
    bot.balanceSol = 0.1
    const wallet = useWalletStore()
    const sentTx: unknown[] = []
    wallet._rpc = vi.fn(async (method: string) => {
      if (method === 'getLatestBlockhash') {
        return { result: { value: { blockhash: 'GfVcyD5xkAqF8QWikjay4bruuTRHVNjJx4KGiqbAbsUp' } } }
      }
      if (method === 'sendTransaction') {
        sentTx.push(method)
        return { result: 'withdraw-txid' }
      }
      return {}
    }) as typeof wallet._rpc
    // 実行中は拒否
    bot.running = true
    await expect(bot.withdraw()).rejects.toThrow(/停止/)
    bot.running = false
    // rent 未満の端数が残る部分出金は拒否（残 = 0.1 - 0.0999 - fee < 0.0009）
    await expect(bot.withdraw(0.0999)).rejects.toThrow(/最低保持額/)
    // 全額出金は成功（残高 - 手数料でちょうど 0）
    const txid = await bot.withdraw()
    expect(txid).toBe('withdraw-txid')
    expect(sentTx).toHaveLength(1)
    expect(bot.log[0].reason).toContain('出金')
  })

  it('リスク未同意・上限未設定・ロック状態では開始できない', async () => {
    const bot = useBotTradeStore()
    await bot.createWallet('passphrase123', OWNER)
    bot.setConfig({ riskConsentAt: null })
    bot.start()
    expect(bot.running).toBe(false)
    bot.setConfig({ riskConsentAt: Date.now(), dailyMaxSol: 0 })
    bot.start()
    expect(bot.running).toBe(false)
    bot.lock()
    bot.setConfig({ riskConsentAt: Date.now(), dailyMaxSol: 1 })
    bot.start()
    expect(bot.running).toBe(false) // ロック中
  })

  it('出金はパスフレーズ解除済みが前提（ロック中は拒否）', async () => {
    const bot = useBotTradeStore()
    await bot.createWallet('passphrase123', OWNER)
    bot.lock()
    await expect(bot.withdraw(0.1)).rejects.toThrow()
  })

  it('リロード後（復元）は鍵情報と状態を保持しつつロック状態になる', async () => {
    const first = useBotTradeStore()
    await first.createWallet('passphrase123', OWNER)
    first.setConfig({ entrySol: 0.2 })
    const pub = first.publicKey

    setActivePinia(createPinia())
    const second = useBotTradeStore()
    second.restoreState()
    expect(second.hasKey).toBe(true)
    expect(second.publicKey).toBe(pub)
    expect(second.ownerAddress).toBe(OWNER)
    expect(second.unlocked).toBe(false)
    expect(second.config.entrySol).toBe(0.2)
    // 正しいパスフレーズで解除できる
    await second.unlock('passphrase123')
    expect(second.unlocked).toBe(true)
  })
})

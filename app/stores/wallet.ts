import { defineStore } from 'pinia'
import { CryptiaError, ERROR_CODES, formatError } from '~/shared/errors'
import { assertTradeAllowed, canEnableAutoTrade, DEFAULT_GUARD } from '~/shared/tradeGuard'
import type { TradeGuardConfig } from '~/shared/types'
import { loadLocal, persist, restore } from '~/composables/usePersistence'
import { useUiStore } from '~/stores/ui'

const GUARD_KEY = 'trade-guard'
const LOG_KEY = 'live-trade-log'
const SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
const JUPITER_QUOTE_URL = 'https://quote-api.jup.ag/v6/quote'
const JUPITER_SWAP_URL = 'https://quote-api.jup.ag/v6/swap'

/** SOL（wrapped）ミントアドレス。Jupiter スワップの入力側として使用 */
export const SOL_MINT = 'So11111111111111111111111111111111111111112'
export const LAMPORTS_PER_SOL = 1_000_000_000

export interface LiveTradeRecord {
  at: number
  side: 'buy' | 'sell'
  inputMint: string
  outputMint: string
  inAmountSol: number
  /** ガード判定用の概算 USD（約定時の SOL 価格で換算） */
  approxUsd: number
  outAmountRaw: string
  outSymbol: string
  txid: string
  auto: boolean
  reason: string
}

export interface JupiterQuote {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  priceImpactPct: string
  routePlan?: unknown[]
}

interface PhantomProvider {
  isPhantom?: boolean
  publicKey: { toString(): string } | null
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey: { toString(): string } }>
  disconnect(): Promise<void>
  signAndSendTransaction(tx: unknown): Promise<{ signature: string }>
}

function getPhantom(): PhantomProvider | null {
  const w = globalThis as unknown as { solana?: PhantomProvider }
  return w.solana?.isPhantom ? w.solana : null
}

/**
 * ウォレット接続・実トレードストア（UC-6 / F-07, F-08）。
 * - 秘密鍵は一切保持しない。署名は Phantom ウォレット内で完結（BR-1）
 * - 取引はリスク同意 + 上限設定のガードを通過した場合のみ（BR-2）
 * - 取引ログは追記型で保存（BR-7）
 */
export const useWalletStore = defineStore('wallet', {
  state: () => ({
    connected: false,
    publicKey: '' as string,
    solBalance: null as number | null,
    guard: { ...DEFAULT_GUARD } as TradeGuardConfig,
    tradeLog: [] as LiveTradeRecord[],
    busy: false,
    restored: false,
  }),
  getters: {
    hasPhantom: () => getPhantom() !== null,
    canAutoTrade(state): boolean {
      return canEnableAutoTrade(state.guard) && state.guard.autoTradeEnabled
    },
    /** 当日の約定合計（概算 USD）。1日上限ガードの判定に使用 */
    todaysSpentUsd(state): number {
      const dayStart = new Date().setHours(0, 0, 0, 0)
      return state.tradeLog.filter((t) => t.at >= dayStart).reduce((s, t) => s + t.approxUsd, 0)
    },
  },
  actions: {
    async restoreState() {
      if (this.restored) return
      const guard = await restore<TradeGuardConfig>(GUARD_KEY)
      if (guard) this.guard = { ...DEFAULT_GUARD, ...guard }
      const log = await restore<LiveTradeRecord[]>(LOG_KEY)
      if (log) this.tradeLog = log
      this.restored = true
    },
    async connect() {
      const ui = useUiStore()
      const phantom = getPhantom()
      if (!phantom) {
        ui.notify(
          'Phantom ウォレットが見つかりません。ブラウザ拡張または Phantom アプリ内ブラウザでご利用ください',
          'warn',
          ERROR_CODES.WALLET_NOT_CONNECTED,
        )
        return
      }
      try {
        const res = await phantom.connect()
        this.publicKey = res.publicKey.toString()
        this.connected = true
        await this.refreshBalance()
        ui.notify('ウォレットを接続しました')
      } catch {
        ui.notifyError(
          new CryptiaError(ERROR_CODES.WALLET_NOT_CONNECTED, 'ウォレット接続がキャンセルまたは失敗しました'),
          '接続失敗',
        )
      }
    },
    async disconnect() {
      try {
        await getPhantom()?.disconnect()
      } finally {
        this.connected = false
        this.publicKey = ''
        this.solBalance = null
      }
    },
    async refreshBalance() {
      if (!this.publicKey) return
      try {
        const res = await fetch(SOLANA_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'getBalance',
            params: [this.publicKey],
          }),
        })
        const data = (await res.json()) as { result?: { value?: number } }
        if (typeof data.result?.value === 'number') {
          this.solBalance = data.result.value / LAMPORTS_PER_SOL
        }
      } catch {
        /* 残高取得失敗は表示のみの問題。取引時に再検証される（原則4） */
      }
    },
    setGuard(patch: Partial<TradeGuardConfig>) {
      this.guard = { ...this.guard, ...patch }
      // 上限が未設定に戻った場合は自動取引を強制無効化（BR-2）
      if (!canEnableAutoTrade(this.guard)) this.guard.autoTradeEnabled = false
      persist(GUARD_KEY, this.guard)
    },
    consentRisk() {
      this.setGuard({ riskConsentAt: Date.now() })
    },
    /** Jupiter スワップ見積り取得 */
    async getQuote(outputMint: string, amountSol: number, slippageBps = 100): Promise<JupiterQuote> {
      const amountLamports = Math.round(amountSol * LAMPORTS_PER_SOL)
      if (amountLamports <= 0) {
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '取引数量が不正です')
      }
      try {
        const url = `${JUPITER_QUOTE_URL}?inputMint=${SOL_MINT}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${slippageBps}`
        const res = await fetch(url)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const quote = (await res.json()) as JupiterQuote & { error?: string }
        if (quote.error || !quote.outAmount) {
          throw new Error(quote.error ?? '見積りが取得できません')
        }
        return quote
      } catch (err) {
        throw new CryptiaError(
          ERROR_CODES.SWAP_QUOTE_FAILED,
          `スワップ見積りの取得に失敗しました: ${err instanceof Error ? err.message : err}`,
        )
      }
    },
    /**
     * スワップ実行（署名は Phantom 内）。
     * @param approxUsd ガード判定用の概算 USD（SOL 価格 × 数量）
     */
    async executeSwap(
      quote: JupiterQuote,
      meta: { outSymbol: string; amountSol: number; approxUsd: number; auto: boolean; reason: string },
    ): Promise<string> {
      const ui = useUiStore()
      const phantom = getPhantom()
      if (!phantom || !this.connected || !this.publicKey) {
        throw new CryptiaError(ERROR_CODES.WALLET_NOT_CONNECTED, 'ウォレットが接続されていません', false)
      }
      // 並行実行ガード: 署名待ちの間の重複注文で日次上限の判定が古くなるのを防ぐ（AUDIT-7）
      if (this.busy) {
        throw new CryptiaError(
          ERROR_CODES.TRADE_GUARD_BLOCKED,
          '別の注文を処理中です。完了を待ってから再試行してください',
        )
      }
      this.busy = true
      try {
        // 他タブが約定させたログを取り込んでから日次消費を判定する（AUDIT-7）
        const latest = loadLocal<LiveTradeRecord[]>(LOG_KEY)
        if (latest && latest.data.length > this.tradeLog.length) {
          this.tradeLog = latest.data
        }
        // 安全ガード（BR-2）: 同意・上限を検証。当日消費は取引ログの概算 USD 合計
        assertTradeAllowed(this.guard, meta.approxUsd, this.todaysSpentUsd, { auto: meta.auto })
        const res = await fetch(JUPITER_SWAP_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            quoteResponse: quote,
            userPublicKey: this.publicKey,
            wrapAndUnwrapSol: true,
            dynamicComputeUnitLimit: true,
          }),
        })
        if (!res.ok) {
          throw new CryptiaError(ERROR_CODES.SWAP_QUOTE_FAILED, `スワップ Tx の生成に失敗（HTTP ${res.status}）`)
        }
        const data = (await res.json()) as { swapTransaction?: string }
        if (!data.swapTransaction) {
          throw new CryptiaError(ERROR_CODES.SWAP_QUOTE_FAILED, 'スワップ Tx が返されませんでした')
        }
        const { VersionedTransaction } = await import('@solana/web3.js')
        const txBytes = Uint8Array.from(atob(data.swapTransaction), (c) => c.charCodeAt(0))
        const tx = VersionedTransaction.deserialize(txBytes)
        const { signature } = await phantom.signAndSendTransaction(tx)

        // 取引ログは追記のみ（BR-7）
        this.tradeLog = [
          {
            at: Date.now(),
            side: 'buy',
            inputMint: quote.inputMint,
            outputMint: quote.outputMint,
            inAmountSol: meta.amountSol,
            approxUsd: meta.approxUsd,
            outAmountRaw: quote.outAmount,
            outSymbol: meta.outSymbol,
            txid: signature,
            auto: meta.auto,
            reason: meta.reason,
          },
          ...this.tradeLog,
        ].slice(0, 200)
        persist(LOG_KEY, JSON.parse(JSON.stringify(this.tradeLog)))
        void this.refreshBalance()
        ui.notify(`スワップを送信しました（${meta.outSymbol}）`)
        return signature
      } catch (err) {
        const { code, message } = formatError(err)
        ui.notify(message, 'error', code)
        throw err
      } finally {
        this.busy = false
      }
    },
    /**
     * 実トレードログの JSON エクスポート（AUDIT-9）。
     * 匿名認証のため端末データ消去で履歴が失われる制約への自衛手段。
     */
    exportLog(): string {
      return JSON.stringify({ exportedAt: Date.now(), tradeLog: this.tradeLog }, null, 2)
    },
    /** エクスポート JSON の取り込み。txid で重複排除し追記のみ（BR-7）。取込件数を返す */
    importLog(json: string): number {
      try {
        const parsed = JSON.parse(json) as { tradeLog?: LiveTradeRecord[] }
        if (!Array.isArray(parsed.tradeLog)) return 0
        const known = new Set(this.tradeLog.map((t) => t.txid))
        const added = parsed.tradeLog.filter(
          (t) =>
            t &&
            typeof t.txid === 'string' &&
            typeof t.at === 'number' &&
            !known.has(t.txid),
        )
        if (added.length > 0) {
          this.tradeLog = [...added, ...this.tradeLog]
            .sort((a, b) => b.at - a.at)
            .slice(0, 200)
          persist(LOG_KEY, JSON.parse(JSON.stringify(this.tradeLog)))
        }
        return added.length
      } catch {
        return 0
      }
    },
  },
})

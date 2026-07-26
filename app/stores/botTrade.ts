import { defineStore } from 'pinia'
import {
  bytesToBase58,
  decryptSecretKey,
  encryptSecretKey,
  type EncryptedSecretKey,
} from '~/shared/botKeyStore'
import { DEX_PAIRS_URL, isValidAddress, toToken, type DexPair } from '~/shared/dexscreener'
import { CryptiaError, ERROR_CODES, formatError } from '~/shared/errors'
import {
  buildMoonbagLadder,
  buildScalpLadder,
  effectiveAgeMinutes,
  MOONBAG_DEFAULT_STOP_LOSS_PCT,
  normalizeMoonbagStopLoss,
  normalizeScalpMaxAge,
  normalizeScalpMaxHold,
  normalizeScalpStop,
  normalizeScalpTarget,
  passesMinimalAudit,
  SCALP_DEFAULT_MAX_AGE_MIN,
  SCALP_DEFAULT_MAX_HOLD_MIN,
  SCALP_DEFAULT_STOP_PCT,
  SCALP_DEFAULT_TARGET_PCT,
  SNIPE_LADDER_RULES,
} from '~/shared/snipeScoring'
import { checkLadder } from '~/shared/tradeEngine'
import type { LadderRule } from '~/shared/types'
import { loadLocal, saveLocal } from '~/composables/usePersistence'
import { JUPITER_SWAP_URL, LAMPORTS_PER_SOL, SOL_MINT, useWalletStore } from '~/stores/wallet'
import { useSolanaStore } from '~/stores/solana'
import { useUiStore } from '~/stores/ui'
import type { Keypair } from '@solana/web3.js'

/**
 * ボットウォレット自動実行ストア（F-13）。
 * 「一度の署名（入金）→ 以後は自動」を実現する専用トレード用ウォレット。
 *
 * 設計原則（BR-1 改訂）:
 * - **メインウォレットの鍵は決して扱わない。** ボット専用に生成した鍵ペアのみを、
 *   パスフレーズで暗号化して**この端末の localStorage にのみ**保存する
 *   （Firestore へは同期しない。したがってボットは端末に紐づき、状態も端末ローカル）
 * - 平文鍵は自動実行の間だけメモリ（モジュール変数）に置き、リロードで消える
 *   （再開にはパスフレーズの再入力が必要）
 * - 出金先は**作成時に登録したメインウォレットのアドレス固定**
 * - すべての買いは SOL 建て上限（1回あたり × 最大同時数・1日あたり）を署名前に強制
 * - 参考データ（モック）表示中・監視データが古い間は執行しない（デモと同じ保護）
 */

const KEY_STORE = 'bot-wallet-key'
const STATE_STORE = 'bot-trade-state'
/** 実資金の執行ティック（Jupiter / RPC への負荷と判断頻度のバランス） */
export const BOT_TICK_MS = 45_000
/** スワップの許容スリッページ（魔界トークンの板の薄さを考慮） */
const BOT_SLIPPAGE_BPS = 300
/** これを超える価格影響の見積りは執行しない（板が薄すぎる = 実質的に売却困難） */
const MAX_PRICE_IMPACT_PCT = 10
/** 手数料・rent 用に常時残す SOL */
const FEE_RESERVE_SOL = 0.01
/** 監視データがこの時間より古い場合は新規エントリーを見送る（デモと同一） */
const MAX_DATA_AGE_MS = 5 * 60 * 1000
/** 1 回のエントリーの下限（これ未満は手数料負けする） */
export const MIN_ENTRY_SOL = 0.01

export type BotStrategy = 'auto-snipe' | 'moonbag' | 'scalp'

export interface BotConfig {
  strategy: BotStrategy
  /** 1 回のエントリー額（SOL） */
  entrySol: number
  maxPositions: number
  allowCaution: boolean
  /** moonbag 戦略の損切りライン（null = なし） */
  stopLossPct: number | null
  /** 1 日の買い合計の上限（SOL） */
  dailyMaxSol: number
  riskConsentAt: number | null
  /** scalp 戦略の設定（他戦略では既定値のまま未使用） */
  scalpTargetPct: number
  scalpStopPct: number
  scalpMaxAgeMin: number
  scalpMaxHoldMin: number
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  strategy: 'moonbag',
  entrySol: 0.05,
  maxPositions: 3,
  allowCaution: false,
  stopLossPct: MOONBAG_DEFAULT_STOP_LOSS_PCT,
  dailyMaxSol: 0.5,
  riskConsentAt: null,
  scalpTargetPct: SCALP_DEFAULT_TARGET_PCT,
  scalpStopPct: SCALP_DEFAULT_STOP_PCT,
  scalpMaxAgeMin: SCALP_DEFAULT_MAX_AGE_MIN,
  scalpMaxHoldMin: SCALP_DEFAULT_MAX_HOLD_MIN,
}

export interface BotPosition {
  mint: string
  pairAddress: string
  symbol: string
  /** エントリー時の戦略・ラダーのスナップショット（後から設定を変えても既存保有の出口は不変: ISSUE-P9-M20） */
  strategy: BotStrategy
  ladder: LadderRule[]
  /** エントリー時の表示価格（USD）。出口ラダーの基準 */
  entryPriceUsd: number
  /** 受取トークンの raw 数量（Jupiter outAmount 起点。売却で減算） */
  amountRaw: string
  /** 投入 SOL（表示・概算損益用） */
  entrySol: number
  triggered: number[]
  moonbagAt?: number
  enteredAt: number
  /** scalp: 保有時間上限のスナップショット（設定変更が既存保有へ遡及しない: ISSUE-P9-M20 と同原則） */
  maxHoldMin?: number
  /** 確認タイムアウトした売却 Tx（着地を実残高照合で確定した際のログ用: ISSUE-P9-L41） */
  pendingTxid?: string
}

export interface BotTradeRecord {
  at: number
  side: 'buy' | 'sell'
  symbol: string
  mint: string
  amountSol: number
  txid: string
  reason: string
}

interface StoredKey {
  enc: EncryptedSecretKey
  publicKey: string
  /** 出金先（作成時に登録したメインウォレット）。変更不可 */
  ownerAddress: string
  createdAt: number
}

interface StoredState {
  config: BotConfig
  positions: BotPosition[]
  enteredMints: string[]
  log: BotTradeRecord[]
  dailySpent: { day: string; sol: number }
}

/** 平文鍵はメモリのみ（reactive state に入れない: Vue Proxy 安全性 + 永続化事故の防止） */
let botKeypair: Keypair | null = null
/** タブ識別子（複数タブの二重実行防止ロック用: ISSUE-P9-M21） */
const tabId = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
const RUN_LOCK = 'cryptia:bot-run-lock'
/** ロックが他タブに保持されているか（ハートビートが 2 ティック分新しい場合） */
function lockHeldByOther(): boolean {
  try {
    const raw = localStorage.getItem(RUN_LOCK)
    if (!raw) return false
    const lock = JSON.parse(raw) as { id?: string; at?: number }
    return lock.id !== tabId && typeof lock.at === 'number' && Date.now() - lock.at < BOT_TICK_MS * 2
  } catch {
    return false
  }
}
function heartbeatLock() {
  try {
    localStorage.setItem(RUN_LOCK, JSON.stringify({ id: tabId, at: Date.now() }))
  } catch {
    /* localStorage 不可なら単一タブ前提で継続 */
  }
}
function releaseLock() {
  try {
    const raw = localStorage.getItem(RUN_LOCK)
    if (raw && (JSON.parse(raw) as { id?: string }).id === tabId) localStorage.removeItem(RUN_LOCK)
  } catch {
    /* noop */
  }
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10)
}

/** ラダー配分（残数量比）を raw 数量に適用する（浮動小数の誤差を避け BigInt で計算） */
export function sellPortionRaw(amountRaw: string, sellRatio: number): string {
  if (sellRatio >= 1) return amountRaw
  const raw = BigInt(amountRaw)
  // 比率は 1e6 精度で適用（ラダー比率 0.3 / 3/7 / 0.5 / 0.7 を十分表現できる）
  return String((raw * BigInt(Math.round(sellRatio * 1_000_000))) / 1_000_000n)
}

export const useBotTradeStore = defineStore('botTrade', {
  state: () => ({
    /** 鍵が作成済みか（暗号化データの存在） */
    hasKey: false,
    publicKey: '' as string,
    ownerAddress: '' as string,
    /** パスフレーズ解除済みか（平文鍵はモジュール変数のみ） */
    unlocked: false,
    running: false,
    busy: false,
    balanceSol: null as number | null,
    config: { ...DEFAULT_BOT_CONFIG } as BotConfig,
    positions: [] as BotPosition[],
    enteredMints: [] as string[],
    log: [] as BotTradeRecord[],
    dailySpent: { day: todayKey(), sol: 0 },
    lastError: '' as string,
    lastTickAt: 0,
    restored: false,
    _timer: null as ReturnType<typeof setInterval> | null,
  }),
  getters: {
    /** ムーンバッグ化していないアクティブポジション数（エントリー枠の判定） */
    activePositionCount(state): number {
      return state.positions.filter((p) => !p.moonbagAt).length
    },
    ladderRules(state): LadderRule[] {
      return state.config.strategy === 'moonbag'
        ? buildMoonbagLadder(state.config.stopLossPct)
        : state.config.strategy === 'scalp'
          ? buildScalpLadder(state.config.scalpTargetPct, state.config.scalpStopPct)
          : SNIPE_LADDER_RULES
    },
    /** 当日の買い合計（SOL）。日付が変わったら 0 から */
    todaysSpentSol(state): number {
      return state.dailySpent.day === todayKey() ? state.dailySpent.sol : 0
    },
  },
  actions: {
    /** 端末ローカルのみから復元（Firestore は使わない: 鍵と同じ端末に閉じる） */
    restoreState() {
      if (this.restored) return
      const key = loadLocal<StoredKey>(KEY_STORE)?.data
      if (key?.enc && key.publicKey) {
        this.hasKey = true
        this.publicKey = key.publicKey
        this.ownerAddress = key.ownerAddress
      }
      const saved = loadLocal<StoredState>(STATE_STORE)?.data
      if (saved) {
        // 復元値は全件検証する（改竄・破損で SOL 建て上限が NaN 化してバイパスされるのを防ぐ:
        // wallet.ts の AUDIT-11 と同水準。不正値は既定値へフォールバック = 安全側）
        const num = (v: unknown, fallback: number) =>
          typeof v === 'number' && Number.isFinite(v) ? v : fallback
        this.config = {
          strategy:
            saved.config?.strategy === 'auto-snipe'
              ? 'auto-snipe'
              : saved.config?.strategy === 'scalp'
                ? 'scalp'
                : 'moonbag',
          entrySol: Math.max(MIN_ENTRY_SOL, num(saved.config?.entrySol, DEFAULT_BOT_CONFIG.entrySol)),
          maxPositions: Math.min(10, Math.max(1, Math.round(num(saved.config?.maxPositions, 3)))),
          allowCaution: saved.config?.allowCaution === true,
          stopLossPct: normalizeMoonbagStopLoss(saved.config?.stopLossPct),
          dailyMaxSol: Math.max(0, num(saved.config?.dailyMaxSol, DEFAULT_BOT_CONFIG.dailyMaxSol)),
          riskConsentAt:
            typeof saved.config?.riskConsentAt === 'number' ? saved.config.riskConsentAt : null,
          scalpTargetPct: normalizeScalpTarget(saved.config?.scalpTargetPct),
          scalpStopPct: normalizeScalpStop(saved.config?.scalpStopPct),
          scalpMaxAgeMin: normalizeScalpMaxAge(saved.config?.scalpMaxAgeMin),
          scalpMaxHoldMin: normalizeScalpMaxHold(saved.config?.scalpMaxHoldMin),
        }
        this.positions = (Array.isArray(saved.positions) ? saved.positions : []).filter(
          (pos): pos is BotPosition =>
            typeof pos === 'object' &&
            pos !== null &&
            typeof pos.mint === 'string' &&
            typeof pos.pairAddress === 'string' &&
            typeof pos.amountRaw === 'string' &&
            /^\d+$/.test(pos.amountRaw) &&
            typeof pos.entryPriceUsd === 'number' &&
            Number.isFinite(pos.entryPriceUsd) &&
            pos.entryPriceUsd > 0 &&
            Array.isArray(pos.triggered) &&
            pos.triggered.every((i: unknown) => Number.isInteger(i)) &&
            typeof pos.enteredAt === 'number' &&
            Number.isFinite(pos.enteredAt) &&
            (pos.pendingTxid === undefined || typeof pos.pendingTxid === 'string'),
        )
        this.enteredMints = (Array.isArray(saved.enteredMints) ? saved.enteredMints : []).filter(
          (m): m is string => typeof m === 'string',
        )
        this.log = (Array.isArray(saved.log) ? saved.log : []).filter(
          (r) => typeof r === 'object' && r !== null && typeof r.txid === 'string',
        )
        if (
          typeof saved.dailySpent?.day === 'string' &&
          typeof saved.dailySpent?.sol === 'number' &&
          Number.isFinite(saved.dailySpent.sol) &&
          saved.dailySpent.sol >= 0
        ) {
          this.dailySpent = { day: saved.dailySpent.day, sol: saved.dailySpent.sol }
        }
      }
      this.restored = true
    },
    _save() {
      saveLocal<StoredState>(STATE_STORE, {
        config: JSON.parse(JSON.stringify(this.config)),
        positions: JSON.parse(JSON.stringify(this.positions)),
        enteredMints: [...this.enteredMints],
        log: JSON.parse(JSON.stringify(this.log)),
        dailySpent: { ...this.dailySpent },
      })
    },
    setConfig(patch: Partial<BotConfig>) {
      this.config = { ...this.config, ...patch }
      if (patch.stopLossPct !== undefined) {
        this.config.stopLossPct = normalizeMoonbagStopLoss(patch.stopLossPct)
      }
      this.config.entrySol = Math.max(MIN_ENTRY_SOL, Number(this.config.entrySol) || MIN_ENTRY_SOL)
      this.config.maxPositions = Math.min(10, Math.max(1, Math.round(this.config.maxPositions) || 1))
      this.config.dailyMaxSol = Math.max(0, Number(this.config.dailyMaxSol) || 0)
      this.config.scalpTargetPct = normalizeScalpTarget(this.config.scalpTargetPct)
      this.config.scalpStopPct = normalizeScalpStop(this.config.scalpStopPct)
      this.config.scalpMaxAgeMin = normalizeScalpMaxAge(this.config.scalpMaxAgeMin)
      this.config.scalpMaxHoldMin = normalizeScalpMaxHold(this.config.scalpMaxHoldMin)
      this._save()
    },
    /**
     * ボットウォレットの新規作成。秘密鍵バックアップ（base58）を**この一度だけ**返す。
     * ownerAddress = 出金先として固定するメインウォレットのアドレス。
     */
    async createWallet(passphrase: string, ownerAddress: string): Promise<string> {
      if (this.hasKey) {
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, 'ボットウォレットは既に存在します（削除してから再作成してください）')
      }
      if (!isValidAddress(ownerAddress)) {
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '出金先（メインウォレット）のアドレスが不正です')
      }
      const { Keypair } = await import('@solana/web3.js')
      const kp = Keypair.generate()
      // 平文メタデータ（公開鍵・出金先）を AAD で暗号文に束縛し、localStorage 上の
      // 出金先すり替えを解除時の復号失敗として検出する（ISSUE-P9-M17）
      const enc = await encryptSecretKey(
        kp.secretKey,
        passphrase,
        `${kp.publicKey.toBase58()}:${ownerAddress}`,
      )
      saveLocal<StoredKey>(KEY_STORE, {
        enc,
        publicKey: kp.publicKey.toBase58(),
        ownerAddress,
        createdAt: Date.now(),
      })
      botKeypair = kp
      this.hasKey = true
      this.unlocked = true
      this.publicKey = kp.publicKey.toBase58()
      this.ownerAddress = ownerAddress
      void this.refreshBalance()
      return bytesToBase58(kp.secretKey)
    },
    /** パスフレーズで解除（リロード後の再開に必要。失敗は例外） */
    async unlock(passphrase: string) {
      const key = loadLocal<StoredKey>(KEY_STORE)?.data
      if (!key?.enc) {
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, 'ボットウォレットが作成されていません')
      }
      const secret = await decryptSecretKey(key.enc, passphrase, `${key.publicKey}:${key.ownerAddress}`)
      const { Keypair } = await import('@solana/web3.js')
      botKeypair = Keypair.fromSecretKey(secret)
      if (botKeypair.publicKey.toBase58() !== key.publicKey) {
        botKeypair = null
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '鍵データが破損しています')
      }
      this.unlocked = true
      void this.refreshBalance()
    },
    /** ロック（平文鍵をメモリから破棄）。自動実行も停止する */
    lock() {
      this.stop()
      botKeypair = null
      this.unlocked = false
    },
    /**
     * ボットウォレットの削除（危険操作）。パスフレーズ解除済みであることを
     * 本人確認とし、残高が残っている場合は UI 側で出金を促してから呼ぶ。
     */
    destroyWallet() {
      if (!this.unlocked) {
        throw new CryptiaError(ERROR_CODES.TRADE_GUARD_BLOCKED, '削除にはパスフレーズ解除が必要です')
      }
      this.lock()
      try {
        localStorage.removeItem(`cryptia:${KEY_STORE}`)
        localStorage.removeItem(`cryptia:${STATE_STORE}`)
      } catch {
        /* localStorage 不可の環境では何も保存されていない */
      }
      this.hasKey = false
      this.publicKey = ''
      this.ownerAddress = ''
      this.positions = []
      this.enteredMints = []
      this.log = []
    },
    async refreshBalance() {
      if (!this.publicKey) return
      try {
        const data = await useWalletStore()._rpc<{ result?: { value?: number } }>('getBalance', [
          this.publicKey,
        ])
        if (typeof data.result?.value === 'number') {
          this.balanceSol = data.result.value / LAMPORTS_PER_SOL
        }
      } catch {
        /* 表示のみ。次回更新で再試行（原則4） */
      }
    },
    /** 自動実行の開始。リスク同意 + 上限設定 + 解除済み鍵が前提（BR-2 と同水準） */
    start() {
      const ui = useUiStore()
      if (!this.unlocked || !botKeypair) {
        ui.notify('パスフレーズでボットウォレットを解除してください', 'warn', ERROR_CODES.TRADE_GUARD_BLOCKED)
        return
      }
      if (this.config.riskConsentAt === null) {
        ui.notify('自動実行のリスク説明に同意してください', 'warn', ERROR_CODES.TRADE_GUARD_BLOCKED)
        return
      }
      if (this.config.dailyMaxSol <= 0) {
        ui.notify('1日あたりの上限（SOL）を設定してください', 'warn', ERROR_CODES.TRADE_GUARD_BLOCKED)
        return
      }
      // 複数タブの二重実行防止（日次上限の二重消費・ポジション記録の相互上書き対策: ISSUE-P9-M21）
      if (lockHeldByOther()) {
        ui.notify('別のタブで自動実行が動作中です。そちらを停止してから開始してください', 'warn', ERROR_CODES.TRADE_GUARD_BLOCKED)
        return
      }
      heartbeatLock()
      this.running = true
      this.lastError = ''
      if (!this._timer) {
        this._timer = setInterval(() => void this.tick(), BOT_TICK_MS)
      }
      void this.tick()
      ui.notify('自動実行を開始しました（このページを開いている間、実資金で執行されます）')
    },
    /** 緊急停止（キルスイッチ）。実行中の署名済み送信は取り消せないが、以後の執行を止める */
    stop() {
      this.running = false
      if (this._timer) {
        clearInterval(this._timer)
        this._timer = null
      }
      releaseLock()
    },
    /** Jupiter スワップ Tx を生成し、ボット鍵で署名して送信する。txid を返す */
    async _signAndSend(quote: unknown): Promise<string> {
      if (!botKeypair) {
        throw new CryptiaError(ERROR_CODES.TRADE_GUARD_BLOCKED, 'ボットウォレットが解除されていません')
      }
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
      const tx = VersionedTransaction.deserialize(
        Uint8Array.from(atob(data.swapTransaction), (c) => c.charCodeAt(0)),
      )
      tx.sign([botKeypair])
      const rawB64 = btoa(String.fromCharCode(...tx.serialize()))
      const sent = await useWalletStore()._rpc<{ result?: string; error?: { message?: string } }>(
        'sendTransaction',
        [rawB64, { encoding: 'base64', maxRetries: 3 }],
      )
      if (typeof sent.result !== 'string') {
        throw new CryptiaError(ERROR_CODES.SWAP_QUOTE_FAILED, `Tx 送信に失敗: ${sent.error?.message ?? '不明'}`)
      }
      return sent.result
    },
    /**
     * Tx のオンチェーン確定を確認する（送信受理 ≠ 確定: ISSUE-P9-H5）。
     * confirmed / finalized で true、実行エラーで false、タイムアウトは null（不明）。
     */
    async _confirmTx(signature: string): Promise<boolean | null> {
      for (let i = 0; i < 8; i++) {
        // 確認待ちは最大 40 秒 = ロック新鮮窓（90 秒）を長ティックで超えないよう鼓動を打つ（ISSUE-P9-M23）
        heartbeatLock()
        await new Promise((resolve) => setTimeout(resolve, 5_000))
        try {
          const data = await useWalletStore()._rpc<{
            result?: { value?: ({ confirmationStatus?: string; err?: unknown } | null)[] }
          }>('getSignatureStatuses', [[signature], { searchTransactionHistory: false }])
          const status = data.result?.value?.[0]
          if (!status) continue
          if (status.err) return false
          if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
            return true
          }
        } catch {
          /* RPC 一時失敗は再試行 */
        }
      }
      return null
    },
    /** ボットウォレットの実トークン残高（raw）。取得失敗は null（呼び出し側で計算値へフォールバック） */
    async _actualBalanceRaw(mint: string): Promise<string | null> {
      try {
        const data = await useWalletStore()._rpc<{
          result?: {
            value?: { account?: { data?: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } }[]
          }
        }>('getTokenAccountsByOwner', [this.publicKey, { mint }, { encoding: 'jsonParsed' }])
        if (!data.result?.value) return null
        let total = 0n
        for (const entry of data.result.value) {
          const amount = entry.account?.data?.parsed?.info?.tokenAmount?.amount
          if (amount && /^\d+$/.test(amount)) total += BigInt(amount)
        }
        return String(total)
      } catch {
        return null
      }
    },
    /** 保有ポジションの現在価格（pairAddress → USD）。取得失敗は空 = 出口判断をスキップ */
    async _fetchPositionPrices(): Promise<Record<string, number>> {
      // 30 件枠はアクティブ保有（出口ルールが生きている）優先（ムーンバッグ蓄積による占有防止）
      const ordered = [...this.positions].sort((a, b) => (a.moonbagAt ? 1 : 0) - (b.moonbagAt ? 1 : 0))
      const addrs = ordered.map((p) => p.pairAddress).filter(isValidAddress).slice(0, 30)
      if (addrs.length === 0) return {}
      try {
        const data = await useSolanaStore()._fetchDex<{ pairs?: DexPair[] }>(
          `${DEX_PAIRS_URL}${addrs.join(',')}`,
          `/api/solana/pairs?addrs=${addrs.join(',')}`,
        )
        const out: Record<string, number> = {}
        for (const p of data.pairs ?? []) {
          const token = toToken(p)
          if (token && token.priceUsd > 0) out[token.pairAddress] = token.priceUsd
        }
        return out
      } catch {
        return {}
      }
    },
    /** 1 ティック: 出口（ラダー）→ 新規エントリーの順で執行する */
    async tick() {
      if (!this.running || this.busy || !botKeypair) return
      // 自己退避: 何らかの理由で別タブがロックを取得していたら自タブを停止する
      // （ロック失効の隙間で二重 start が成立しても恒久併走にしない: ISSUE-P9-M23）
      if (lockHeldByOther()) {
        this.stop()
        this.lastError = '別のタブが自動実行を開始したため、このタブは停止しました'
        return
      }
      this.busy = true
      try {
        heartbeatLock()
        const solana = useSolanaStore()
        // 出口: 保有ポジションのラダー判定（価格が取れた銘柄のみ）。
        // ムーンバッグ化済みは全ルール無効の恒久保持のためスキップ（戦略切替でも売却されない: ISSUE-P9-M20）
        const prices = await this._fetchPositionPrices()
        for (const position of [...this.positions]) {
          if (!this.running) break
          if (position.moonbagAt) continue
          // スキャルプ: 利確にも損切りにも届かない銘柄は時間切れで全量手仕舞い（枠の固定化防止）。
          // 価格フィード喪失（ラグ等）でも執行する — 売却は Jupiter 見積りベースで表示価格は不要
          // （ISSUE-P9-M24）。上限はエントリー時のスナップショットを優先（ISSUE-P9-L43）
          if (
            position.strategy === 'scalp' &&
            Date.now() - position.enteredAt >
              normalizeScalpMaxHold(position.maxHoldMin ?? this.config.scalpMaxHoldMin) * 60_000
          ) {
            await this._sell(
              position,
              1,
              -1,
              false,
              0,
              position.ladder?.length ? position.ladder : this.ladderRules,
              `スキャルプ時間切れ: ${normalizeScalpMaxHold(position.maxHoldMin ?? this.config.scalpMaxHoldMin)} 分以内に利確/損切りへ届かず全量手仕舞い（枠を回転）`,
            )
            continue
          }
          const price = prices[position.pairAddress]
          if (!price) continue
          // 出口はエントリー時のラダースナップショットで判定（設定変更の影響を受けない）
          const rules = position.ladder?.length ? position.ladder : this.ladderRules
          const fired = checkLadder(position.entryPriceUsd, price, rules, position.triggered)
          for (const { index, rule } of fired) {
            const isMoonbagTp = position.strategy === 'moonbag' && rule.triggerPct >= 0
            await this._sell(position, rule.sellRatio, index, isMoonbagTp, rule.triggerPct, rules)
            if (isMoonbagTp || rule.sellRatio >= 1) break
          }
        }
        // 新規エントリー: デモの自動スナイプと同じ監視・監査ゲート
        await solana.fetchFreshTokens()
        if (solana.usingMockData) return
        if (Date.now() - solana.freshFetchedAt > MAX_DATA_AGE_MS) return
        await this.refreshBalance()
        const now = Date.now()
        // 1) 候補の確定（上限・監査・重複を全て通過したものだけ）
        const candidates: { mint: string; addr: string; symbol: string; priceUsd: number }[] = []
        let plannedSol = 0
        for (const score of solana.freshTokens) {
          if (this.activePositionCount + candidates.length >= this.config.maxPositions) break
          const mint = score.token.baseAddress
          const addr = score.token.pairAddress
          if (now - (solana.freshSeenAt[addr] ?? solana.freshFetchedAt) > MAX_DATA_AGE_MS) continue
          if (!passesMinimalAudit(score, { allowCaution: this.config.allowCaution })) continue
          if (this.enteredMints.includes(mint)) continue
          if (this.positions.some((p) => p.mint === mint)) continue
          if (!isValidAddress(mint) || !isValidAddress(addr) || score.token.priceUsd <= 0) continue
          // スキャルプ: 発行直後（実効経過が上限以内）のトークンだけを対象にする
          if (
            this.config.strategy === 'scalp' &&
            (!score.token.ageKnown ||
              effectiveAgeMinutes(
              score.token.ageHours,
              solana.freshSeenAt[addr] ?? solana.freshFetchedAt,
              now,
              ) > this.config.scalpMaxAgeMin)
          ) {
            continue
          }
          // SOL 建て上限の強制（署名前・安全側）
          const entrySol = this.config.entrySol
          if (this.todaysSpentSol + plannedSol + entrySol > this.config.dailyMaxSol) break
          if ((this.balanceSol ?? 0) - plannedSol < entrySol + FEE_RESERVE_SOL) break
          plannedSol += entrySol
          candidates.push({ mint, addr, symbol: score.token.baseSymbol, priceUsd: score.token.priceUsd })
        }
        // 2) 執行直前に価格を再取得してラダー基準の乖離を防ぐ（デモと同じ改良: ISSUE-P9-L38）
        if (candidates.length > 0) {
          try {
            const data = await useSolanaStore()._fetchDex<{ pairs?: DexPair[] }>(
              `${DEX_PAIRS_URL}${candidates.map((c) => c.addr).join(',')}`,
              `/api/solana/pairs?addrs=${candidates.map((c) => c.addr).join(',')}`,
            )
            for (const pair of data.pairs ?? []) {
              const token = toToken(pair)
              const c = token && candidates.find((x) => x.addr === token.pairAddress)
              if (c && token && token.priceUsd > 0) c.priceUsd = token.priceUsd
            }
          } catch {
            /* 直前価格の取得失敗は監視価格で継続（5 分鮮度ゲートで有界） */
          }
        }
        // 3) 執行
        for (const c of candidates) {
          if (!this.running) break
          await this._buy(c.mint, c.addr, c.symbol, c.priceUsd, this.config.entrySol)
        }
      } catch (err) {
        this.lastError = formatError(err).message
      } finally {
        this.lastTickAt = Date.now()
        this.busy = false
        this._save()
      }
    },
    async _buy(mint: string, pairAddress: string, symbol: string, priceUsd: number, entrySol: number) {
      try {
        const wallet = useWalletStore()
        const quote = await wallet.getQuoteRaw(
          SOL_MINT,
          mint,
          String(Math.round(entrySol * LAMPORTS_PER_SOL)),
          BOT_SLIPPAGE_BPS,
        )
        // 板が薄すぎる銘柄は執行しない（買えても売れない事故の予防）。
        // priceImpactPct 欠落（NaN）はガード素通りではなく不執行に倒す（安全側: ISSUE-P9-L37）
        const impact = Number.parseFloat(quote.priceImpactPct)
        if (!Number.isFinite(impact) || impact > MAX_PRICE_IMPACT_PCT) return
        const txid = await this._signAndSend(quote)
        // 日次消費は送信時点で計上する（確定不明でも安全側 = 上限は早く締まる方向にしか誤らない）
        const day = todayKey()
        this.dailySpent =
          this.dailySpent.day === day
            ? { day, sol: this.dailySpent.sol + entrySol }
            : { day, sol: entrySol }
        this.enteredMints = [...this.enteredMints, mint].slice(-500)
        // オンチェーン確定を確認してからポジションを確定する（送信受理 ≠ 確定: ISSUE-P9-H5）。
        // 確定失敗（err）はポジションを作らない。タイムアウト（不明）は着地している可能性が
        // 高いため記録する — 万一の幻ポジションは全量売却時の実残高照合で自然消滅する（ISSUE-P9-H4）
        const confirmed = await this._confirmTx(txid)
        if (confirmed === false) {
          this._log('buy', symbol, mint, entrySol, txid, `エントリー Tx がオンチェーンで失敗（ポジション未成立）`)
          return
        }
        this.positions.push({
          mint,
          pairAddress,
          symbol,
          strategy: this.config.strategy,
          ladder: this.ladderRules.map((r) => ({ ...r })),
          maxHoldMin: this.config.strategy === 'scalp' ? this.config.scalpMaxHoldMin : undefined,
          entryPriceUsd: priceUsd,
          amountRaw: quote.outAmount,
          entrySol,
          triggered: [],
          enteredAt: Date.now(),
        })
        this._log('buy', symbol, mint, entrySol, txid, `監査通過の新規上場 ${symbol} へ自動エントリー`)
        this.balanceSol = this.balanceSol === null ? null : this.balanceSol - entrySol
      } catch (err) {
        // 1 銘柄の失敗で全体を止めない（原則4）。理由は表示して次ティックで継続
        this.lastError = formatError(err).message
      }
    },
    async _sell(
      position: BotPosition,
      sellRatio: number,
      ruleIndex: number,
      isMoonbagTp: boolean,
      triggerPct: number,
      rules: LadderRule[],
      reasonOverride?: string,
    ) {
      try {
        let sellRaw = sellPortionRaw(position.amountRaw, sellRatio)
        // 売却は比率を問わず**実残高**と照合して執行する（ISSUE-P9-H4 / L40）。
        // - 実残高ゼロ = 幻ポジション（買い Tx ドロップ等）→ 記録から除去
        // - 全量売却は実残高そのもので執行（スリッページ乖離での恒久失敗防止）
        // - 部分売却は min(計算値, 実残高)。実残高が「この段の執行後」相当まで減っていれば
        //   前回送信が着地済み（確認タイムアウト再試行）とみなし、二重執行せず段を確定する
        const actual = await this._actualBalanceRaw(position.mint)
        if (actual !== null) {
          const actualBig = BigInt(actual)
          if (actualBig <= 0n) {
            this.positions = this.positions.filter((p) => p.mint !== position.mint)
            return
          }
          if (sellRatio >= 1) {
            sellRaw = actual
          } else {
            const computed = BigInt(sellRaw)
            const remainderAfter = BigInt(position.amountRaw) - computed
            if (actualBig <= remainderAfter) {
              position.triggered.push(ruleIndex)
              position.amountRaw = actual
              // 着地済み売却を追記型ログへ記録する（BR-7。金額は確認不能のため 0 + 注記）
              this._log(
                'sell',
                position.symbol,
                position.mint,
                0,
                position.pendingTxid ?? `reconciled-${position.mint.slice(0, 8)}-${ruleIndex}`,
                `前回送信の売却の着地を実残高照合で確認（段確定。受取額は Solscan 参照）`,
              )
              position.pendingTxid = undefined
              if (isMoonbagTp) {
                position.moonbagAt = Date.now()
                position.triggered = rules.map((_, i) => i)
              }
              return
            }
            if (computed > actualBig) sellRaw = actual
          }
        }
        if (BigInt(sellRaw) <= 0n) {
          position.triggered.push(ruleIndex)
          return
        }
        const quote = await useWalletStore().getQuoteRaw(position.mint, SOL_MINT, sellRaw, BOT_SLIPPAGE_BPS)
        const txid = await this._signAndSend(quote)
        // オンチェーン確定を確認してから状態を進める（未確定で進めると売れ残りが不可視化する:
        // ISSUE-P9-H5）。確定失敗・タイムアウトは進めず次ティックで再判定（全量売却は実残高
        // 照合があるため、着地済みの再試行でも二重売却にならない）
        const confirmed = await this._confirmTx(txid)
        if (confirmed !== true) {
          // 着地している可能性があるため txid を保持（次ティックの照合確定時にログへ記録）
          position.pendingTxid = txid
          this.lastError = `売却 Tx が確定しませんでした（次ティックで再試行）: ${txid.slice(0, 8)}…`
          return
        }
        position.pendingTxid = undefined
        position.triggered.push(ruleIndex)
        position.amountRaw =
          sellRatio >= 1 ? '0' : String(BigInt(position.amountRaw) - BigInt(sellRaw))
        const outSol = Number(quote.outAmount) / LAMPORTS_PER_SOL
        const reason =
          reasonOverride ??
          (isMoonbagTp
            ? `ムーンバッグ利確: +${triggerPct}% 到達で ${Math.round(sellRatio * 100)}% を売却（残りは保持）`
            : triggerPct >= 0
              ? `ラダー利確: +${triggerPct}% 到達で ${Math.round(sellRatio * 100)}% 決済`
              : `ラダー損切り: ${triggerPct}% 到達で全量決済`)
        this._log('sell', position.symbol, position.mint, outSol, txid, reason)
        if (isMoonbagTp) {
          position.moonbagAt = Date.now()
          position.triggered = rules.map((_, i) => i)
        }
        if (BigInt(position.amountRaw) <= 0n) {
          this.positions = this.positions.filter((p) => p.mint !== position.mint)
        }
      } catch (err) {
        // 売却失敗は次ティックで再判定される（triggered を進めない）
        this.lastError = formatError(err).message
      }
    },
    _log(side: 'buy' | 'sell', symbol: string, mint: string, amountSol: number, txid: string, reason: string) {
      this.log = [{ at: Date.now(), side, symbol, mint, amountSol, txid, reason }, ...this.log].slice(0, 200)
    },
    /** 出金（SOL）。宛先は作成時に登録したメインウォレット固定 */
    async withdraw(amountSol?: number): Promise<string> {
      if (!botKeypair || !this.unlocked) {
        throw new CryptiaError(ERROR_CODES.TRADE_GUARD_BLOCKED, '出金にはパスフレーズ解除が必要です')
      }
      if (!this.ownerAddress) {
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '出金先が登録されていません')
      }
      if (this.running) {
        throw new CryptiaError(ERROR_CODES.TRADE_GUARD_BLOCKED, '自動実行を停止してから出金してください')
      }
      await this.refreshBalance()
      const balanceLamports = Math.floor((this.balanceSol ?? 0) * LAMPORTS_PER_SOL)
      const TX_FEE_LAMPORTS = 5_000
      // rent-exempt 最低残高（データなし口座 ≈ 0.00089 SOL）。0 超かつこれ未満に減らす
      // 送金はチェーンに拒否されるため、全額出金は残高をちょうど 0 にする（ISSUE-P9-M19）
      const RENT_EXEMPT_MIN_LAMPORTS = 900_000
      const lamports =
        amountSol === undefined
          ? balanceLamports - TX_FEE_LAMPORTS
          : Math.floor(amountSol * LAMPORTS_PER_SOL)
      if (lamports <= 0 || lamports + TX_FEE_LAMPORTS > balanceLamports) {
        throw new CryptiaError(ERROR_CODES.INVALID_INPUT, '出金額が不正です（残高不足）')
      }
      const remaining = balanceLamports - lamports - TX_FEE_LAMPORTS
      if (remaining > 0 && remaining < RENT_EXEMPT_MIN_LAMPORTS) {
        throw new CryptiaError(
          ERROR_CODES.INVALID_INPUT,
          '出金後の残高が最低保持額（約 0.0009 SOL）を下回るため送金できません。金額を調整するか「全額」で出金してください',
        )
      }
      const sol = lamports / LAMPORTS_PER_SOL
      const { PublicKey, SystemProgram, Transaction } = await import('@solana/web3.js')
      const wallet = useWalletStore()
      const blockhash = await wallet._rpc<{ result?: { value?: { blockhash?: string } } }>(
        'getLatestBlockhash',
        [{ commitment: 'finalized' }],
      )
      const recentBlockhash = blockhash.result?.value?.blockhash
      if (!recentBlockhash) {
        throw new CryptiaError(ERROR_CODES.DEX_FETCH_FAILED, 'blockhash を取得できません（RPC 混雑）')
      }
      const tx = new Transaction({
        feePayer: botKeypair.publicKey,
        recentBlockhash,
      }).add(
        SystemProgram.transfer({
          fromPubkey: botKeypair.publicKey,
          toPubkey: new PublicKey(this.ownerAddress),
          lamports,
        }),
      )
      tx.sign(botKeypair)
      const rawB64 = btoa(String.fromCharCode(...new Uint8Array(tx.serialize())))
      const sent = await wallet._rpc<{ result?: string; error?: { message?: string } }>(
        'sendTransaction',
        [rawB64, { encoding: 'base64', maxRetries: 3 }],
      )
      if (typeof sent.result !== 'string') {
        throw new CryptiaError(ERROR_CODES.SWAP_QUOTE_FAILED, `出金 Tx の送信に失敗: ${sent.error?.message ?? '不明'}`)
      }
      this._log('sell', 'SOL', SOL_MINT, sol, sent.result, `メインウォレットへ出金`)
      this._save()
      void this.refreshBalance()
      return sent.result
    },
  },
})

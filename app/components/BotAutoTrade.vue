<script setup lang="ts">
import { Bot, Copy, Eye, Lock, Pause, Play, TriangleAlert, Wallet } from '@lucide/vue'
import { fmtAgo, fmtPct } from '~/shared/format'
import { MIN_ENTRY_SOL, useBotTradeStore, type BotStrategy } from '~/stores/botTrade'
import { useWalletStore } from '~/stores/wallet'
import { useSolanaStore } from '~/stores/solana'
import { useUiStore } from '~/stores/ui'

/**
 * ボットウォレット自動実行（F-13）。
 * 「一度の署名（入金）→ 以後は自動」の実資金自動取引。専用ウォレット限定・
 * SOL 建て上限・リスク同意・緊急停止・出金先固定の安全装置つき。
 */
const bot = useBotTradeStore()
const wallet = useWalletStore()
const solana = useSolanaStore()
const ui = useUiStore()

const passphrase = ref('')
const passphrase2 = ref('')
const unlockPass = ref('')
const backupKey = ref('') // 作成直後のみ表示（この一度だけ）
const showBackup = ref(false)
const depositSol = ref(0.1)
const withdrawSol = ref<number | null>(null)
const botBusy = ref(false)

const strategyLabel: Record<BotStrategy, string> = {
  'auto-snipe': '自動スナイプ（利益確保型ラダー）',
  moonbag: 'ムーンバッグ（+100%で70%売却→残り保持）',
  scalp: 'スキャルプ（発行直後買い・早期全量利確で高速回転）',
}

async function createWallet() {
  if (passphrase.value !== passphrase2.value) {
    ui.notify('パスフレーズが一致しません', 'warn')
    return
  }
  if (!wallet.connected) {
    ui.notify('先にメインウォレットを接続してください（出金先として登録されます）', 'warn')
    return
  }
  botBusy.value = true
  try {
    backupKey.value = await bot.createWallet(passphrase.value, wallet.publicKey)
    passphrase.value = ''
    passphrase2.value = ''
    ui.notify('ボットウォレットを作成しました。秘密鍵のバックアップを必ず保管してください')
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    botBusy.value = false
  }
}

async function unlock() {
  botBusy.value = true
  try {
    await bot.unlock(unlockPass.value)
    unlockPass.value = ''
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    botBusy.value = false
  }
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    ui.notify('コピーしました')
  } catch {
    ui.notify('コピーに失敗しました。表示された文字列を手動で保管してください', 'warn')
  }
}

async function deposit() {
  if (!wallet.connected) {
    ui.notify('メインウォレットを接続してください', 'warn')
    return
  }
  botBusy.value = true
  try {
    await wallet.sendSol(bot.publicKey, depositSol.value)
    ui.notify(`${depositSol.value} SOL の入金を送信しました（反映まで数十秒かかることがあります）`)
    setTimeout(() => void bot.refreshBalance(), 15_000)
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    botBusy.value = false
  }
}

async function withdraw() {
  if (!window.confirm(`ボットウォレットの SOL を登録済みのメインウォレット\n${bot.ownerAddress}\nへ出金します。よろしいですか？`)) return
  botBusy.value = true
  try {
    // v-model.number は空欄で '' を返すため、正の数値のみ金額指定として扱う（それ以外は全額）
    const amount =
      typeof withdrawSol.value === 'number' && withdrawSol.value > 0 ? withdrawSol.value : undefined
    await bot.withdraw(amount)
    ui.notify('出金を送信しました')
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : String(err), 'error')
  } finally {
    botBusy.value = false
  }
}

function confirmDestroy() {
  const hasFunds = (bot.balanceSol ?? 0) > 0.001 || bot.positions.length > 0
  const msg = hasFunds
    ? '警告: 残高またはポジションが残っています。削除すると秘密鍵が失われ、バックアップがない場合は資金へ二度とアクセスできません。先に全売却と出金を行うことを強く推奨します。それでも削除しますか？'
    : 'ボットウォレットの鍵と実行状態をこの端末から削除します。バックアップした秘密鍵がない場合、復元はできません。削除しますか？'
  if (!window.confirm(msg)) return
  try {
    bot.destroyWallet()
    ui.notify('ボットウォレットを削除しました')
  } catch (err) {
    ui.notify(err instanceof Error ? err.message : String(err), 'error')
  }
}

function positionPnlPct(entryPriceUsd: number, pairAddress: string): number | null {
  const price = solana.tokenOf(pairAddress)?.priceUsd
  if (!price || entryPriceUsd <= 0) return null
  return ((price - entryPriceUsd) / entryPriceUsd) * 100
}

onMounted(() => {
  bot.restoreState()
  if (bot.hasKey) void bot.refreshBalance()
})
</script>

<template>
  <section class="card bot-card">
    <div class="card-title">
      <h2><Bot :size="18" class="icon-inline" aria-hidden="true" />自動実行（ボットウォレット）</h2>
      <span v-if="bot.running" class="badge badge-up">実行中</span>
      <span v-else-if="bot.unlocked" class="badge badge-warn">停止中</span>
    </div>
    <p class="xs dim">
      専用トレード用ウォレットで署名を自動化し、新規上場トークンの自動売買を<b>実資金</b>で行います。
      鍵はパスフレーズで暗号化して<b>この端末にのみ</b>保存され、クラウドへは同期されません（実行・状態も端末単位）。
      メインウォレットの鍵は扱いません。
    </p>

    <!-- 未作成: セットアップ -->
    <template v-if="!bot.hasKey">
      <div class="setup-warn xs" role="note">
        <TriangleAlert :size="13" class="icon-inline" aria-hidden="true" />
        入金した資金は、端末の紛失・パスフレーズ漏洩・ブラウザ経由の攻撃で不可逆に失われる可能性があります。
        <b>失っても許容できる金額だけ</b>を入金してください。自動監査はハニーポット・ラグを完全には排除できません。
      </div>
      <div class="grid grid-2">
        <label class="field">
          <span>パスフレーズ（8文字以上・忘れると復元不可）</span>
          <input v-model="passphrase" type="password" class="input" autocomplete="new-password" />
        </label>
        <label class="field">
          <span>パスフレーズ（確認）</span>
          <input v-model="passphrase2" type="password" class="input" autocomplete="new-password" />
        </label>
      </div>
      <p class="xs dim">
        出金先は現在接続中のメインウォレット（{{ wallet.connected ? `${wallet.publicKey.slice(0, 4)}…${wallet.publicKey.slice(-4)}` : '未接続' }}）に固定されます。
      </p>
      <button class="btn btn-primary" type="button" :disabled="botBusy || passphrase.length < 8 || !wallet.connected" @click="createWallet">
        <Wallet :size="15" aria-hidden="true" /> ボットウォレットを作成
      </button>
    </template>

    <!-- 作成直後: 秘密鍵バックアップ（この一度だけ表示） -->
    <template v-if="backupKey">
      <div class="backup-box">
        <p class="xs" style="color: var(--warn)">
          <TriangleAlert :size="13" class="icon-inline" aria-hidden="true" />
          <b>秘密鍵のバックアップ（この画面を閉じると二度と表示されません）。</b>
          オフラインの安全な場所に保管してください。パスフレーズを忘れた場合、この鍵だけが資金を取り戻す手段です。
        </p>
        <div class="controls">
          <button class="btn btn-sm" type="button" @click="showBackup = !showBackup">
            <Eye :size="13" aria-hidden="true" /> {{ showBackup ? '隠す' : '表示する' }}
          </button>
          <button class="btn btn-sm" type="button" @click="copyText(backupKey)">
            <Copy :size="13" aria-hidden="true" /> コピー
          </button>
          <button class="btn btn-sm btn-ghost" type="button" @click="backupKey = ''; showBackup = false">
            保管しました（閉じる）
          </button>
        </div>
        <code v-if="showBackup" class="mono xs backup-key">{{ backupKey }}</code>
      </div>
    </template>

    <!-- 作成済み・ロック中 -->
    <template v-if="bot.hasKey && !bot.unlocked">
      <p class="small">
        ボットウォレット: <code class="mono xs">{{ bot.publicKey.slice(0, 6) }}…{{ bot.publicKey.slice(-6) }}</code>
        <template v-if="bot.balanceSol !== null">（残高 {{ bot.balanceSol.toFixed(4) }} SOL）</template>
      </p>
      <div class="grid grid-2">
        <label class="field">
          <span>パスフレーズで解除（リロード後は再入力が必要です）</span>
          <input v-model="unlockPass" type="password" class="input" autocomplete="current-password" @keydown.enter="unlock" />
        </label>
        <div class="field" style="justify-content: flex-end">
          <button class="btn btn-primary" type="button" :disabled="botBusy || unlockPass.length === 0" @click="unlock">
            解除
          </button>
        </div>
      </div>
    </template>

    <!-- 解除済み: ダッシュボード -->
    <template v-if="bot.hasKey && bot.unlocked">
      <div class="stats-grid">
        <div>
          <div class="xs faint">ボット残高</div>
          <div class="mono bold">{{ bot.balanceSol === null ? '—' : `${bot.balanceSol.toFixed(4)} SOL` }}</div>
        </div>
        <div>
          <div class="xs faint">アクティブ / ムーンバッグ</div>
          <div class="mono">{{ bot.activePositionCount }} / {{ bot.positions.length - bot.activePositionCount }}</div>
        </div>
        <div>
          <div class="xs faint">本日の投入</div>
          <div class="mono">{{ bot.todaysSpentSol.toFixed(3) }} / {{ bot.config.dailyMaxSol }} SOL</div>
        </div>
        <div>
          <div class="xs faint">累計エントリー</div>
          <div class="mono">{{ bot.enteredMints.length }} 件</div>
        </div>
      </div>
      <p class="xs faint" style="margin: 0 0 8px">
        ウォレット: <code class="mono">{{ bot.publicKey.slice(0, 6) }}…{{ bot.publicKey.slice(-6) }}</code>
        <button class="btn btn-sm btn-ghost" type="button" style="margin-left: 4px" @click="copyText(bot.publicKey)">
          <Copy :size="11" aria-hidden="true" /> コピー
        </button>
        <template v-if="bot.lastTickAt">・最終判定 {{ fmtAgo(bot.lastTickAt) }}</template>
      </p>
      <p v-if="bot.lastError" class="xs" style="color: var(--warn)">
        <TriangleAlert :size="12" class="icon-inline" aria-hidden="true" />
        直近のエラー: {{ bot.lastError }}（自動で再試行されます）
      </p>

      <!-- 設定（実行中は変更不可にして表示と執行の乖離を防ぐ） -->
      <div class="grid grid-2">
        <label class="field">
          <span>戦略</span>
          <select v-model="bot.config.strategy" class="input" :disabled="bot.running" @change="bot.setConfig({ strategy: bot.config.strategy })">
            <option value="moonbag">{{ strategyLabel['moonbag'] }}</option>
            <option value="auto-snipe">{{ strategyLabel['auto-snipe'] }}</option>
            <option value="scalp">{{ strategyLabel['scalp'] }}</option>
          </select>
        </label>
        <label class="field">
          <span>1回のエントリー額（SOL・最低 {{ MIN_ENTRY_SOL }}）</span>
          <input v-model.number="bot.config.entrySol" type="number" class="input" :min="MIN_ENTRY_SOL" step="0.01" :disabled="bot.running" @change="bot.setConfig({ entrySol: bot.config.entrySol })" />
        </label>
        <label class="field">
          <span>最大同時ポジション数（ムーンバッグ化した保有は除く）</span>
          <input v-model.number="bot.config.maxPositions" type="number" class="input" min="1" max="10" :disabled="bot.running" @change="bot.setConfig({ maxPositions: bot.config.maxPositions })" />
        </label>
        <label class="field">
          <span>1日の投入上限（SOL）</span>
          <input v-model.number="bot.config.dailyMaxSol" type="number" class="input" min="0" step="0.1" :disabled="bot.running" @change="bot.setConfig({ dailyMaxSol: bot.config.dailyMaxSol })" />
        </label>
        <label v-if="bot.config.strategy === 'moonbag'" class="field">
          <span>損切りライン（+100% 到達前のみ）</span>
          <select v-model="bot.config.stopLossPct" class="input" :disabled="bot.running" @change="bot.setConfig({ stopLossPct: bot.config.stopLossPct })">
            <option :value="-50">-50%（推奨）</option>
            <option :value="-30">-30%</option>
            <option :value="-70">-70%</option>
            <option :value="null">なし（完全放置・全損リスク）</option>
          </select>
        </label>
        <label class="field">
          <span>監査基準</span>
          <select v-model="bot.config.allowCaution" class="input" :disabled="bot.running" @change="bot.setConfig({ allowCaution: bot.config.allowCaution })">
            <option :value="false">「候補」判定のみ（推奨）</option>
            <option :value="true">「要注意」まで許容</option>
          </select>
        </label>
        <template v-if="bot.config.strategy === 'scalp'">
          <label class="field">
            <span>利確ターゲット（到達で全量売却・%）</span>
            <input v-model.number="bot.config.scalpTargetPct" type="number" class="input" min="20" max="200" step="10" :disabled="bot.running" @change="bot.setConfig({ scalpTargetPct: bot.config.scalpTargetPct })" />
          </label>
          <label class="field">
            <span>損切りライン（%・負値）</span>
            <input v-model.number="bot.config.scalpStopPct" type="number" class="input" min="-90" max="-10" step="5" :disabled="bot.running" @change="bot.setConfig({ scalpStopPct: bot.config.scalpStopPct })" />
          </label>
          <label class="field">
            <span>発行からの経過上限（分）</span>
            <input v-model.number="bot.config.scalpMaxAgeMin" type="number" class="input" min="1" max="30" step="1" :disabled="bot.running" @change="bot.setConfig({ scalpMaxAgeMin: bot.config.scalpMaxAgeMin })" />
          </label>
          <label class="field">
            <span>保有時間の上限（分・届かなければ全量手仕舞い）</span>
            <input v-model.number="bot.config.scalpMaxHoldMin" type="number" class="input" min="3" max="120" step="1" :disabled="bot.running" @change="bot.setConfig({ scalpMaxHoldMin: bot.config.scalpMaxHoldMin })" />
          </label>
        </template>
      </div>
      <p v-if="bot.config.strategy === 'scalp'" class="xs dim" style="margin: 0 0 6px">
        スキャルプは検知できた最速の新規発行トークンを高速回転させます（発行検知はフィード経由のため
        「真の発行 5 分以内」は保証されません）。売買回数が増えるほど手数料・スリッページの累積が
        損益を圧迫します。1 回のエントリー額と 1 日上限をタイトに設定してください。
      </p>

      <label class="consent xs">
        <input
          type="checkbox"
          :checked="bot.config.riskConsentAt !== null"
          :disabled="bot.running"
          @change="bot.setConfig({ riskConsentAt: ($event.target as HTMLInputElement).checked ? Date.now() : null })"
        />
        実資金が自動で執行されること・ハニーポット等で投入額を全て失い得ることを理解しました
      </label>

      <div class="controls">
        <button v-if="!bot.running" class="btn btn-primary" type="button" :disabled="bot.config.riskConsentAt === null" @click="bot.start()">
          <Play :size="14" aria-hidden="true" /> 自動実行を開始
        </button>
        <button v-else class="btn btn-danger" type="button" @click="bot.stop()">
          <Pause :size="14" aria-hidden="true" /> 緊急停止
        </button>
        <button class="btn btn-sm btn-ghost" type="button" @click="bot.lock()">
          <Lock :size="13" aria-hidden="true" /> ロック（鍵をメモリから破棄）
        </button>
      </div>
      <p v-if="bot.running" class="xs dim" style="margin-top: 4px">
        このページ（アプリ）を開いている間、約 45 秒ごとに判定・執行します（バックグラウンドタブでは
        ブラウザの制限により間隔が延びることがあります）。タブを閉じると停止し、再開にはパスフレーズが必要です。
        複数のタブで同時に解除・実行しないでください（二重実行は自動でブロックされます）。
      </p>

      <!-- 保有ポジション -->
      <h3 style="margin-top: 12px">ボットの保有ポジション</h3>
      <p v-if="bot.positions.length === 0" class="dim small">ポジションなし</p>
      <div v-for="p in bot.positions" :key="p.mint" class="pos-row small">
        <span class="bold">{{ p.symbol }}</span>
        <span class="mono xs">{{ p.entrySol }} SOL 投入</span>
        <span v-if="positionPnlPct(p.entryPriceUsd, p.pairAddress) !== null" class="mono" :class="positionPnlPct(p.entryPriceUsd, p.pairAddress)! >= 0 ? 'up' : 'down'">
          {{ fmtPct(positionPnlPct(p.entryPriceUsd, p.pairAddress)!) }}
        </span>
        <span v-if="p.moonbagAt" class="badge">ムーンバッグ保持中</span>
        <span v-else class="xs faint">ラダー {{ p.triggered.length }}/{{ bot.ladderRules.length }}</span>
      </div>

      <!-- 入出金 -->
      <div class="grid grid-2" style="margin-top: 12px">
        <div class="field">
          <span class="small dim">入金（メインウォレットから・要署名1回）</span>
          <div class="controls">
            <input v-model.number="depositSol" type="number" class="input" min="0.01" step="0.05" style="max-width: 120px" />
            <button class="btn btn-sm" type="button" :disabled="botBusy || !wallet.connected" @click="deposit">入金</button>
          </div>
        </div>
        <div class="field">
          <span class="small dim">出金（登録済みメインウォレット宛のみ）</span>
          <div class="controls">
            <input v-model.number="withdrawSol" type="number" class="input" min="0" step="0.05" placeholder="空欄=全額" style="max-width: 120px" />
            <button class="btn btn-sm" type="button" :disabled="botBusy || bot.running" @click="withdraw">出金</button>
          </div>
        </div>
      </div>

      <!-- 実行ログ -->
      <template v-if="bot.log.length > 0">
        <h3 style="margin-top: 12px">実行ログ</h3>
        <div v-for="r in bot.log.slice(0, 20)" :key="r.txid" class="pos-row xs">
          <span class="xs faint nowrap">{{ fmtAgo(r.at) }}</span>
          <span class="badge" :class="r.side === 'buy' ? 'badge-up' : ''">{{ r.side === 'buy' ? '買' : '売' }}</span>
          <span class="bold">{{ r.symbol }}</span>
          <span class="mono">{{ r.amountSol.toFixed(4) }} SOL</span>
          <a v-if="!r.txid.startsWith('reconciled-')" class="xs" :href="`https://solscan.io/tx/${r.txid}`" target="_blank" rel="noopener">Solscan</a>
        </div>
      </template>

      <details class="danger-zone" style="margin-top: 12px">
        <summary class="xs" style="color: var(--warn); cursor: pointer">危険な操作</summary>
        <p class="xs dim" style="margin: 6px 0">
          削除すると鍵と実行状態がこの端末から消えます。残高がある場合は先に全売却と出金を行ってください。
        </p>
        <button class="btn btn-sm btn-danger" type="button" @click="confirmDestroy">ボットウォレットを削除</button>
      </details>
    </template>
  </section>
</template>

<style scoped>
.bot-card { border-left: 3px solid var(--warn); }
.stats-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin-bottom: 10px; }
@media (min-width: 768px) { .stats-grid { grid-template-columns: repeat(4, 1fr); } }
.controls { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.setup-warn {
  background: color-mix(in srgb, var(--warn) 12%, transparent);
  border: 1px solid var(--warn);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  margin-bottom: 10px;
}
.backup-box {
  background: var(--bg);
  border: 1px dashed var(--warn);
  border-radius: var(--radius-sm);
  padding: 10px;
  margin: 10px 0;
}
.backup-key { display: block; margin-top: 8px; word-break: break-all; user-select: all; }
.consent { display: flex; gap: 8px; align-items: flex-start; margin: 8px 0; cursor: pointer; }
.consent input { margin-top: 2px; }
.pos-row { display: flex; gap: 10px; align-items: center; padding: 6px 0; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
.pos-row:last-child { border-bottom: none; }
</style>

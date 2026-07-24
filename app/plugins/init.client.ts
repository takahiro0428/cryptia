import { useMarketStore } from '~/stores/market'
import { useUiStore } from '~/stores/ui'

/**
 * アプリ初期化（クライアント専用）。
 * - 免責既読状態の復元（BR-6）
 * - 市場データのポーリング開始（アプリ全体で共有・多重起動なし）
 */
export default defineNuxtPlugin(() => {
  const ui = useUiStore()
  ui.restoreDisclaimer()
  const market = useMarketStore()
  market.startPolling()
})

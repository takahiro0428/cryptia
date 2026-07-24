import { defineStore } from 'pinia'
import { formatError } from '~/shared/errors'

export interface Toast {
  id: number
  message: string
  kind: 'info' | 'warn' | 'error'
  code?: string
}

let toastSeq = 0

/** グローバル UI 状態（トースト通知・免責同意） */
export const useUiStore = defineStore('ui', {
  state: () => ({
    toasts: [] as Toast[],
    /** 初回免責の既読（BR-6） */
    disclaimerAcknowledged: false,
  }),
  actions: {
    notify(message: string, kind: Toast['kind'] = 'info', code?: string) {
      const id = ++toastSeq
      this.toasts.push({ id, message, kind, code })
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id)
      }, 5000)
    },
    /** 想定エラーをコード付きで通知し、コンソールにも構造化ログを残す */
    notifyError(err: unknown, fallbackMessage: string) {
      const { code, message } = formatError(err)
      console.error(`[${code}] ${message}`)
      this.notify(message || fallbackMessage, 'error', code)
    },
    acknowledgeDisclaimer() {
      this.disclaimerAcknowledged = true
      try {
        localStorage.setItem('cryptia:disclaimer', '1')
      } catch {
        /* プライベートモード等で失敗しても続行（原則4） */
      }
    },
    restoreDisclaimer() {
      try {
        this.disclaimerAcknowledged = localStorage.getItem('cryptia:disclaimer') === '1'
      } catch {
        this.disclaimerAcknowledged = false
      }
    },
  },
})

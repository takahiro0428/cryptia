import { ERROR_CODES } from '~/shared/errors'
import { useFirebase } from '~/composables/useFirebase'

/**
 * 状態永続化（F-11）。
 * SoT はクライアント操作結果（まずローカルへ書く）。Firestore は同期キャッシュとして
 * 後追い更新する（原則6: SoT への書込が先、キャッシュが後）。
 * 復元時は「更新時刻が新しい方」を採用し、複数端末間の同期に対応する。
 */

interface Persisted<T> {
  savedAt: number
  data: T
}

const PREFIX = 'cryptia:'

export function saveLocal<T>(key: string, data: T, savedAt = Date.now()): void {
  try {
    localStorage.setItem(`${PREFIX}${key}`, JSON.stringify({ savedAt, data } satisfies Persisted<T>))
  } catch {
    /* 容量超過等は無視（原則4: 補助処理の失敗で主要フローを止めない） */
  }
}

export function loadLocal<T>(key: string): Persisted<T> | null {
  try {
    const raw = localStorage.getItem(`${PREFIX}${key}`)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Persisted<T>
    if (typeof parsed?.savedAt !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/** 同期失敗のユーザー通知は 1 セッション 1 回まで（サイレント恒久失敗の防止: AUDIT-P9-1） */
let syncFailureNotified = false

/** Firestore へ非同期バックアップ（ベストエフォート） */
async function saveRemote<T>(key: string, payload: Persisted<T>): Promise<void> {
  const ctx = await useFirebase()
  if (!ctx) return
  try {
    const { doc, setDoc } = await import('firebase/firestore')
    // コレクション名は共有プロジェクトでの他アプリとの衝突回避のため cryptia- prefix
    await setDoc(doc(ctx.db, 'cryptia-users', ctx.uid, 'state', key), {
      savedAt: payload.savedAt,
      json: JSON.stringify(payload.data),
    })
  } catch (err) {
    console.warn(`[${ERROR_CODES.SYNC_FAILED}] Firestore 同期失敗（ローカル保存は完了済み）: ${err instanceof Error ? err.message : err}`)
    if (!syncFailureNotified) {
      syncFailureNotified = true
      try {
        // 動的 import で循環依存を避ける（補助処理の失敗は主要フローを止めない: 原則4）
        const { useUiStore } = await import('~/stores/ui')
        useUiStore().notify(
          'クラウド同期に失敗しました。データは端末に保存されています（端末間の引き継ぎのみ影響）',
          'warn',
          ERROR_CODES.SYNC_FAILED,
        )
      } catch {
        /* 通知失敗は無視 */
      }
    }
  }
}

async function loadRemote<T>(key: string): Promise<Persisted<T> | null> {
  const ctx = await useFirebase()
  if (!ctx) return null
  try {
    const { doc, getDoc } = await import('firebase/firestore')
    const snap = await getDoc(doc(ctx.db, 'cryptia-users', ctx.uid, 'state', key))
    if (!snap.exists()) return null
    const raw = snap.data() as { savedAt?: number; json?: string }
    if (typeof raw.savedAt !== 'number' || typeof raw.json !== 'string') return null
    return { savedAt: raw.savedAt, data: JSON.parse(raw.json) as T }
  } catch {
    return null
  }
}

/** 保存: ローカル（SoT 反映）→ Firestore（キャッシュ）の順 */
export function persist<T>(key: string, data: T): void {
  const savedAt = Date.now()
  saveLocal(key, data, savedAt)
  void saveRemote(key, { savedAt, data })
}

/** 復元: ローカルと Firestore の新しい方を採用 */
export async function restore<T>(key: string): Promise<T | null> {
  const local = loadLocal<T>(key)
  const remote = await loadRemote<T>(key)
  if (local && remote) return remote.savedAt > local.savedAt ? remote.data : local.data
  return (remote ?? local)?.data ?? null
}

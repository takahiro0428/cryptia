import type { FirebaseApp } from 'firebase/app'
import type { Firestore } from 'firebase/firestore'
import { CryptiaError, ERROR_CODES } from '~/shared/errors'

/**
 * Firebase 遅延初期化（設定がある場合のみ）。
 * runtimeConfig.public に Firebase 設定が無い環境（ローカル開発・デモ）では
 * null を返し、アプリはローカルストレージのみで全機能動作する（BR-5）。
 * 認証は匿名認証（Phase 3: ユーザー権限）。Google アカウントへのリンクで
 * uid を保持したまま永続化できる（AUDIT-9 対応の本実装）。
 */

export interface AccountInfo {
  isAnonymous: boolean
  email: string | null
}

interface FirebaseContext {
  app: FirebaseApp
  db: Firestore
  uid: string
  /** AI API 認証用の ID トークン（取得失敗時 null） */
  getIdToken(): Promise<string | null>
  /** 匿名アカウントを Google アカウントへリンク（uid は変わらずデータ保持） */
  linkWithGoogle(): Promise<AccountInfo>
  /** 現在のアカウント状態 */
  accountInfo(): AccountInfo
}

let initPromise: Promise<FirebaseContext | null> | null = null

export function useFirebase(): Promise<FirebaseContext | null> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    try {
      const config = useRuntimeConfig().public
      if (!config.firebaseApiKey || !config.firebaseProjectId) return null
      const { initializeApp, getApps } = await import('firebase/app')
      const { getAuth, signInAnonymously, onAuthStateChanged } = await import('firebase/auth')
      const { getFirestore } = await import('firebase/firestore')

      const app =
        getApps()[0] ??
        initializeApp({
          apiKey: config.firebaseApiKey,
          authDomain: config.firebaseAuthDomain,
          projectId: config.firebaseProjectId,
          appId: config.firebaseAppId,
        })
      const auth = getAuth(app)
      const uid = await new Promise<string>((resolve, reject) => {
        const unsub = onAuthStateChanged(auth, (user) => {
          if (user) {
            unsub()
            resolve(user.uid)
          }
        })
        signInAnonymously(auth).catch((e) => {
          unsub()
          reject(e)
        })
      })
      // リダイレクト方式のアカウント連携から復帰した場合の完了処理（ISSUE-P8-11）
      try {
        const { getRedirectResult } = await import('firebase/auth')
        await getRedirectResult(auth)
      } catch {
        /* 復帰結果のエラー（連携済み等）は AccountLink 側の状態表示に委ねる */
      }

      // 共有プロジェクト同居のため専用の名前付きデータベースを使用する
      // （Security Rules がデータベース単位になり、他アプリのルールと完全分離される）
      const databaseId = config.firebaseDatabaseId || 'cryptia'
      const db = databaseId === '(default)' ? getFirestore(app) : getFirestore(app, databaseId)

      return {
        app,
        db,
        uid,
        async getIdToken() {
          try {
            return (await auth.currentUser?.getIdToken()) ?? null
          } catch {
            return null
          }
        },
        async linkWithGoogle() {
          const { GoogleAuthProvider, linkWithPopup, linkWithRedirect } = await import('firebase/auth')
          const user = auth.currentUser
          if (!user) {
            throw new CryptiaError(ERROR_CODES.ACCOUNT_LINK_FAILED, 'サインイン状態を確認できません')
          }
          const provider = new GoogleAuthProvider()
          try {
            const result = await linkWithPopup(user, provider)
            return { isAnonymous: result.user.isAnonymous, email: result.user.email }
          } catch (err) {
            const code = (err as { code?: string }).code
            if (code === 'auth/credential-already-in-use') {
              throw new CryptiaError(
                ERROR_CODES.ACCOUNT_LINK_FAILED,
                'この Google アカウントは既に別のデータに連携されています。別のアカウントをお試しください',
              )
            }
            // WebView（Phantom アプリ内ブラウザ等）ではポップアップが開けないため
            // リダイレクト方式へフォールバックする（ISSUE-P8-11）。
            // ページ遷移するため戻り値は到達しない（復帰時に getRedirectResult で完了する）
            if (
              code === 'auth/popup-blocked' ||
              code === 'auth/operation-not-supported-in-this-environment' ||
              code === 'auth/cancelled-popup-request'
            ) {
              await linkWithRedirect(user, provider)
              return { isAnonymous: true, email: null }
            }
            throw new CryptiaError(
              ERROR_CODES.ACCOUNT_LINK_FAILED,
              'アカウント連携がキャンセルまたは失敗しました',
            )
          }
        },
        accountInfo() {
          const user = auth.currentUser
          return { isAnonymous: user?.isAnonymous ?? true, email: user?.email ?? null }
        },
      }
    } catch (err) {
      console.warn(`Firebase 初期化に失敗（ローカルモードで継続）: ${err instanceof Error ? err.message : err}`)
      return null
    }
  })()
  return initPromise
}

/** AI API 用の認証ヘッダー（Firebase 未設定環境では空 = 匿名扱い） */
export async function aiAuthHeaders(): Promise<Record<string, string>> {
  const ctx = await useFirebase()
  const token = ctx ? await ctx.getIdToken() : null
  return token ? { Authorization: `Bearer ${token}` } : {}
}

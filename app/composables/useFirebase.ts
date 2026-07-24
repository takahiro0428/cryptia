import type { FirebaseApp } from 'firebase/app'
import type { Firestore } from 'firebase/firestore'

/**
 * Firebase 遅延初期化（設定がある場合のみ）。
 * runtimeConfig.public に Firebase 設定が無い環境（ローカル開発・デモ）では
 * null を返し、アプリはローカルストレージのみで全機能動作する（BR-5）。
 * 認証は匿名認証（Phase 3: ユーザー権限）。
 */

interface FirebaseContext {
  app: FirebaseApp
  db: Firestore
  uid: string
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
      // 共有プロジェクト同居のため専用の名前付きデータベースを使用する
      // （Security Rules がデータベース単位になり、他アプリのルールと完全分離される）
      const databaseId = config.firebaseDatabaseId || 'cryptia'
      const db =
        databaseId === '(default)' ? getFirestore(app) : getFirestore(app, databaseId)
      return { app, db, uid }
    } catch (err) {
      console.warn(`Firebase 初期化に失敗（ローカルモードで継続）: ${err instanceof Error ? err.message : err}`)
      return null
    }
  })()
  return initPromise
}

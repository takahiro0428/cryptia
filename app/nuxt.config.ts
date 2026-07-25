// Cryptia — AI トレード支援アプリ
// SPA (ssr: false) + Nitro server API 構成。Firebase Hosting + Cloud Functions へデプロイする。
// デプロイ時は NITRO_PRESET=firebase を指定する（.ai-native/guides/deploy-guide.md 参照）。
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2026-07-01',
  modules: ['@pinia/nuxt', '@vite-pwa/nuxt'],
  css: ['~/assets/css/main.css'],
  app: {
    // ページ遷移の軽いフェード（操作の連続性。reduced-motion 環境では CSS 側で無効化）
    pageTransition: { name: 'page', mode: 'out-in' },
    head: {
      title: 'Cryptia — AI Trade Assistant',
      meta: [
        { name: 'viewport', content: 'width=device-width, initial-scale=1, viewport-fit=cover' },
        { name: 'theme-color', content: '#0b1020' },
        {
          name: 'description',
          content: '仮想通貨・株式トークン・ゴールドトークンのトレードを AI が支援するアプリ',
        },
      ],
      link: [{ rel: 'apple-touch-icon', href: '/icons/icon-192.png' }],
    },
  },
  nitro: {
    preset: process.env.NITRO_PRESET,
    // SPA シェルを静的 index.html として出力する（ssr: false では既定で
    // サーバーレンダラーが担うため、これがないと Hosting の
    // 「** → /index.html」rewrite が 404 になる）。CDN 配信で初期表示も速くなる
    prerender: { routes: ['/'] },
    firebase: {
      gen: 2,
      // 共有 Firebase プロジェクトでの同居前提のため、既定の 'server' から
      // アプリ名 prefix 付きへ変更（他アプリの関数名との衝突回避）。
      // firebase.json の hosting rewrite（functionId）と一致させること
      serverFunctionName: 'cryptiaserver',
      httpsOptions: { region: 'asia-northeast1', maxInstances: 3 },
      // Node 20 は 2026-10-30 に GCF ランタイム廃止のため 22 を使用
      nodeVersion: '22',
    },
  },
  runtimeConfig: {
    // サーバー専用（クライアントへは公開されない）。値は環境変数
    // NUXT_GCP_PROJECT_ID / NUXT_VERTEX_LOCATION / NUXT_VERTEX_MODEL で上書きする。
    gcpProjectId: '',
    vertexLocation: 'asia-northeast1',
    vertexModel: 'gemini-2.0-flash',
    public: {
      // Firebase Web SDK 設定（公開可の識別子。未設定時はローカルモードで動作）
      firebaseApiKey: '',
      firebaseAuthDomain: '',
      firebaseProjectId: '',
      firebaseAppId: '',
      // Firestore の名前付きデータベース ID。共有プロジェクトでの他アプリとの
      // 同居のため専用 DB（既定: cryptia）を使用する。'(default)' で既定 DB に戻せる
      firebaseDatabaseId: 'cryptia',
    },
  },
  pwa: {
    registerType: 'autoUpdate',
    manifest: {
      name: 'Cryptia — AI Trade Assistant',
      short_name: 'Cryptia',
      description: '仮想通貨・株式トークン・ゴールドトークンの AI トレード支援',
      lang: 'ja',
      display: 'standalone',
      orientation: 'portrait',
      background_color: '#0b1020',
      theme_color: '#0b1020',
      start_url: '/',
      icons: [
        { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
        { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    workbox: {
      navigateFallback: '/',
      globPatterns: ['**/*.{js,css,html,png,svg,ico}'],
      runtimeCaching: [
        {
          // 価格系 API は「ネット優先・失敗時キャッシュ」。オフラインでも最終値を表示する（BR-5）
          // キャッシュ名は他アプリとの同居を考慮しアプリ名 prefix を付与
          urlPattern: /^https:\/\/api\.coingecko\.com\/.*/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'cryptia-market-data',
            networkTimeoutSeconds: 8,
            expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 },
          },
        },
        {
          urlPattern: /^https:\/\/api\.dexscreener\.com\/.*/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'cryptia-dex-data',
            networkTimeoutSeconds: 8,
            expiration: { maxEntries: 32, maxAgeSeconds: 60 * 30 },
          },
        },
      ],
    },
    devOptions: { enabled: false },
  },
})

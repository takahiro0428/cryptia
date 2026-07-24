// Cryptia — AI トレード支援アプリ
// SPA (ssr: false) + Nitro server API 構成。Firebase Hosting + Cloud Functions へデプロイする。
// デプロイ時は NITRO_PRESET=firebase を指定する（.ai-native/guides/deploy-guide.md 参照）。
export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2026-07-01',
  modules: ['@pinia/nuxt', '@vite-pwa/nuxt'],
  css: ['~/assets/css/main.css'],
  app: {
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
    firebase: {
      gen: 2,
      httpsOptions: { region: 'asia-northeast1', maxInstances: 3 },
      nodeVersion: '20',
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
          urlPattern: /^https:\/\/api\.coingecko\.com\/.*/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'market-data',
            networkTimeoutSeconds: 8,
            expiration: { maxEntries: 64, maxAgeSeconds: 60 * 60 },
          },
        },
        {
          urlPattern: /^https:\/\/api\.dexscreener\.com\/.*/,
          handler: 'NetworkFirst',
          options: {
            cacheName: 'dex-data',
            networkTimeoutSeconds: 8,
            expiration: { maxEntries: 32, maxAgeSeconds: 60 * 30 },
          },
        },
      ],
    },
    devOptions: { enabled: false },
  },
})

<script setup lang="ts">
import {
  Bot,
  BookOpen,
  ChartCandlestick,
  FlaskConical,
  Orbit,
  TrendingUp,
  Waves,
  Zap,
} from '@lucide/vue'

// ナビゲーション定義。モバイルは主要5項目の下部タブ、PC は全項目のサイドナビ（原則8）。
// アイコンは lucide（絵文字は使用しない: UI 品質ポリシー）
const NAV_ITEMS = [
  { to: '/', icon: markRaw(ChartCandlestick), label: 'マーケット', mobile: true },
  { to: '/flows', icon: markRaw(Orbit), label: 'フロー', mobile: true },
  { to: '/insights', icon: markRaw(Bot), label: 'AI分析', mobile: true },
  { to: '/trade', icon: markRaw(TrendingUp), label: 'トレード', mobile: true },
  { to: '/strategy', icon: markRaw(BookOpen), label: '戦略', mobile: true },
  { to: '/trade/demo', icon: markRaw(FlaskConical), label: 'デモトレード', mobile: false },
  { to: '/trade/solana', icon: markRaw(Waves), label: 'Solana魔界', mobile: false },
  { to: '/trade/live', icon: markRaw(Zap), label: '実トレード', mobile: false },
]

const route = useRoute()
// '/' は完全一致、'/trade' は配下ページ（/trade/demo 等）でもアクティブにする
function isActive(to: string): boolean {
  if (to === '/') return route.path === '/'
  if (to === '/trade') return route.path === '/trade'
  return route.path === to || route.path.startsWith(`${to}/`)
}
</script>

<template>
  <nav class="nav-desktop" aria-label="メインナビゲーション">
    <div class="brand">Cryp<span>tia</span></div>
    <NuxtLink
      v-for="item in NAV_ITEMS"
      :key="item.to"
      :to="item.to"
      :class="{ 'nav-active': isActive(item.to) }"
    >
      <component :is="item.icon" :size="18" aria-hidden="true" />{{ item.label }}
    </NuxtLink>
  </nav>

  <main class="app-main">
    <slot />
  </main>

  <nav class="nav-mobile" aria-label="メインナビゲーション">
    <NuxtLink
      v-for="item in NAV_ITEMS.filter((i) => i.mobile)"
      :key="item.to"
      :to="item.to"
      :class="{ 'nav-active': item.to === '/trade' ? route.path.startsWith('/trade') : isActive(item.to) }"
    >
      <component :is="item.icon" :size="21" aria-hidden="true" />
      <span>{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>

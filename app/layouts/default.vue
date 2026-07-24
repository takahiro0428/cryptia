<script setup lang="ts">
// ナビゲーション定義。モバイルは主要5項目の下部タブ、PC は全項目のサイドナビ（原則8）。
const NAV_ITEMS = [
  { to: '/', icon: '📊', label: 'マーケット', mobile: true },
  { to: '/flows', icon: '🫧', label: 'フロー', mobile: true },
  { to: '/insights', icon: '🤖', label: 'AI分析', mobile: true },
  { to: '/trade', icon: '💹', label: 'トレード', mobile: true },
  { to: '/strategy', icon: '📚', label: '戦略', mobile: true },
  { to: '/trade/demo', icon: '🧪', label: 'デモトレード', mobile: false },
  { to: '/trade/solana', icon: '🌊', label: 'Solana魔界', mobile: false },
  { to: '/trade/live', icon: '⚡', label: '実トレード', mobile: false },
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
      <span class="icon">{{ item.icon }}</span>{{ item.label }}
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
      <span class="icon">{{ item.icon }}</span>
      <span>{{ item.label }}</span>
    </NuxtLink>
  </nav>
</template>

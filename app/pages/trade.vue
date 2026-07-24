<script setup lang="ts">
// トレードハブ（モバイル下部タブからの入口）
useHead({ title: 'トレード | Cryptia' })

const MENUS = [
  {
    to: '/trade/demo',
    icon: '🧪',
    title: 'AI デモトレード',
    desc: '初期資金を設定して AI の自動売買を仮想資金で検証。注文ごとの判断理由とサマリーを確認できます。',
    badge: 'リスクなし',
    badgeCls: 'badge-up',
  },
  {
    to: '/trade/solana',
    icon: '🌊',
    title: 'Solana 魔界トレード',
    desc: 'Solana チェーンの草コインをスコアリングで選定し、AI 取引またはラダーロジック（+100%で50%利確等）で自動取引。',
    badge: '超高リスク',
    badgeCls: 'badge-down',
  },
  {
    to: '/trade/live',
    icon: '⚡',
    title: '実トレード',
    desc: 'Phantom ウォレットを接続し、Jupiter 経由で実際のスワップを実行。AI 自動化はリスク同意と上限設定後のみ。',
    badge: '実資金',
    badgeCls: 'badge-warn',
  },
]
</script>

<template>
  <div>
    <h1>トレード</h1>
    <DisclaimerBanner />
    <div class="grid" style="margin-top: 12px">
      <NuxtLink v-for="m in MENUS" :key="m.to" :to="m.to" class="card menu-card">
        <div class="card-title">
          <h2>{{ m.icon }} {{ m.title }}</h2>
          <span class="badge" :class="m.badgeCls">{{ m.badge }}</span>
        </div>
        <p class="small dim" style="margin: 0">{{ m.desc }}</p>
      </NuxtLink>
    </div>
  </div>
</template>

<style scoped>
.menu-card { display: block; color: var(--text); transition: border-color 0.15s; }
.menu-card:hover { border-color: var(--accent); }
</style>

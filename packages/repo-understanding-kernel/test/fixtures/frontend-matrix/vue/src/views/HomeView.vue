<script setup lang="ts">
import { ref } from 'vue'

const status = ref('idle')

async function submitOrder() {
  const response = await fetch('/api/orders', { method: 'POST' })
  status.value = response.ok ? 'success' : 'failed'
}
</script>

<template>
  <main>
    <button @click="submitOrder">Create order</button>
    <p v-if="status === 'success'" role="status" data-outcome="order-created">Order created</p>
  </main>
</template>

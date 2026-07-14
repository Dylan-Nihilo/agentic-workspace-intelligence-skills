import { useState } from 'react'

export function CheckoutPage() {
  const [status, setStatus] = useState<'idle' | 'pending' | 'success' | 'error'>('idle')

  async function submitOrder() {
    setStatus('pending')
    try {
      const response = await fetch('/api/orders', { method: 'POST' })
      if (!response.ok) throw new Error('Order request failed')
      setStatus('success')
    } catch {
      setStatus('error')
    }
  }

  return (
    <main>
      <button onClick={submitOrder}>Submit order</button>
      {status === 'success' ? <p role="status">Order created</p> : null}
      {status === 'error' ? <p role="alert">Order failed</p> : null}
      {status === 'success' ? <output data-outcome="order-created">Checkout complete</output> : null}
      {status === 'error' ? <output data-outcome="order-failed">Checkout failed</output> : null}
    </main>
  )
}

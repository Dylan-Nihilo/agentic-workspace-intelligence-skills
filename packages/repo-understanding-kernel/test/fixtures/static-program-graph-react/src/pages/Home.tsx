import { useState } from 'react'
import { Card } from '../components/Card'

type RequestStatus = 'idle' | 'loading' | 'success' | 'error'

export function HomePage(props: { content?: unknown }) {
  const [status, setStatus] = useState<RequestStatus>('idle')

  async function handleCreateOrder() {
    setStatus('loading')
    const response = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sku: 'fixture-item' }),
    })
    setStatus(response.ok ? 'success' : 'error')
  }

  return (
    <main>
      <Card label="Order workspace" />
      {props.content}
      <button type="button" onClick={handleCreateOrder}>
        Create order
      </button>
      <p role="status">
        {status === 'loading' && 'Creating order'}
        {status === 'error' && 'Order creation failed'}
        {status === 'success' && 'Order created'}
      </p>
      {status === 'success' && <output data-testid="order-created">Order is visible</output>}
    </main>
  )
}

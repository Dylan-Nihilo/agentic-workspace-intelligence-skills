import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { HomePage } from './Home'

describe('HomePage', () => {
  it('creates an order from the primary action', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }))
    render(<HomePage />)

    fireEvent.click(screen.getByRole('button', { name: 'Create order' }))

    expect((await screen.findByRole('status')).textContent).toContain('Order created')
  })
})

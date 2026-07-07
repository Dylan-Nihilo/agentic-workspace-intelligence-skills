import { createRouter } from './router'
import { canAccessAdmin } from './auth'
import { fetchInvoice } from './api'

const router = createRouter()

if (canAccessAdmin(['admin'])) {
  router.push('/admin')
}

fetchInvoice('INV-001')

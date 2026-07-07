import { request } from './request'

export function fetchInvoice(invoiceId: string) {
  return request(`/api/invoices/${invoiceId}`)
}

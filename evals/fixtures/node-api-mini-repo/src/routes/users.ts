import type { Express } from 'express'

export function registerUserRoutes(app: Express) {
  app.get('/users/:id', (_request, response) => {
    response.json({ id: 'demo-user' })
  })
}

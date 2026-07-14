import express from 'express'

const app = express()
app.get('/api/health', (_request, response) => response.json({ ok: true }))
app.listen(3000)

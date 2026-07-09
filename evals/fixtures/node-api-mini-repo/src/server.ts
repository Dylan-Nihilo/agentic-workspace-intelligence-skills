import express from 'express'
import { registerUserRoutes } from './routes/users'

const app = express()

registerUserRoutes(app)

app.listen(8080)

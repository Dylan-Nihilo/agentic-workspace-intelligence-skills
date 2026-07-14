import { createBrowserRouter } from 'react-router-dom'
import { RequireAuth } from './auth/RequireAuth'
import { AppLayout } from './layouts/AppLayout'
import { HomePage } from './pages/Home'

export const router = createBrowserRouter([
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          {
            path: '/',
            element: <HomePage />,
          },
        ],
      },
    ],
  },
  {
    path: '/login',
    element: <p>Sign in required</p>,
  },
])

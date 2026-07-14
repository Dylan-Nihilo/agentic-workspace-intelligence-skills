import { Navigate, Outlet } from 'react-router-dom'

export function RequireAuth() {
  const accessToken = localStorage.getItem('access-token')
  return accessToken ? <Outlet /> : <Navigate to="/login" replace />
}

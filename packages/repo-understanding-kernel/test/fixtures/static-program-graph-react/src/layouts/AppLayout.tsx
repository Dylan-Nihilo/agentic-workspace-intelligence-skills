import { Outlet } from 'react-router-dom'

export function AppLayout() {
  return (
    <div className="app-shell">
      <header>Order console</header>
      <Outlet />
    </div>
  )
}

import HomePage from './views/HomePage.vue'
import AdminPage from './views/AdminPage.vue'
import { canAccessAdmin } from './auth'

export function createRouter() {
  const routes = [
    { path: '/', component: HomePage },
    { path: '/admin', component: AdminPage, beforeEnter: () => canAccessAdmin(['admin']) },
  ]

  return {
    routes,
    push(path: string) {
      return routes.find(route => route.path === path)
    },
  }
}

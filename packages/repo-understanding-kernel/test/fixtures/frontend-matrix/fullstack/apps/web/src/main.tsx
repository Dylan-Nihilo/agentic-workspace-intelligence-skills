import { createRoot } from 'react-dom/client'

function WebApp() {
  return <main>Web application</main>
}

createRoot(document.getElementById('app')!).render(<WebApp />)

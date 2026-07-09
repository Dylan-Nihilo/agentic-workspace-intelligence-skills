import { Button } from './components/Button'
import { HomePage } from '@/pages/Home'

export function App() {
  return <HomePage action={<Button label="Save" />} />
}

import type { Ghost } from './missing'
import { Card } from './components/Card'
import { HomePage } from '@/pages/Home'
import { HomePage as BaseUrlHome } from 'src/pages/Home'
import { HomePage as ExactHome } from 'ExactHome'
import { HomePage as FallbackHome } from 'fallback/pages/Home'

export function App() {
  const ghost: Ghost | null = null
  void BaseUrlHome
  void ExactHome
  void FallbackHome
  return <HomePage content={<Card label={ghost ? 'Ghost' : 'Home'} />} />
}

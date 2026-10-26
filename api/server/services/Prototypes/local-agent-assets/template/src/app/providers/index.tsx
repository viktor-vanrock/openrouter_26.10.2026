import { HashRouter as BrowserRouter } from 'react-router-dom'
import type { ReactNode } from 'react'

interface ProvidersProps {
  children: ReactNode
}

export function Providers({ children }: ProvidersProps) {
  return (
    <BrowserRouter basename="/">
      {children}
    </BrowserRouter>
  )
}

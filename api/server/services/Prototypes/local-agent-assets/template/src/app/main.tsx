import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { Providers } from './providers'
import './styles/globals.css'

async function enableMocking() {
  if (import.meta.env.DEV) {
    const { createWorker } = await import('@/shared/api/msw-setup')
    const worker = await createWorker()
    return worker.start({ onUnhandledRequest: 'warn', serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` } })
  }
}

enableMocking().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <Providers>
        <App />
      </Providers>
    </React.StrictMode>
  )
})

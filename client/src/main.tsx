import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
const AvatarStudio = lazy(() => import('./AvatarStudio').then((m) => ({ default: m.AvatarStudio })))

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname.startsWith('/avatar') ? (
      <Suspense fallback={null}>
        <AvatarStudio />
      </Suspense>
    ) : (
      <App />
    )}
  </StrictMode>,
)

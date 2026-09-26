import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'

// /          wireframe: every agent chat running on behalf of one user account
// /console   the multi-tenant terminal console
const Console = lazy(() => import('./App.tsx'))
const Wireframe = lazy(() => import('./wireframe/Wireframe').then((m) => ({ default: m.Wireframe })))

const Page = location.pathname.startsWith('/console') ? Console : Wireframe
document.title = Page === Console ? 'Agent Console' : 'Agent Activity'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)

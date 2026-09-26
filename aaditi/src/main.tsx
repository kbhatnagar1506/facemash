import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'

// /          the Muse web: you at the centre, every agent your muse talked to around you
// /console   the multi-tenant terminal console
const Console = lazy(() => import('./App.tsx'))
const Muse = lazy(() => import('./muse/Muse').then((m) => ({ default: m.Muse })))

const Page = location.pathname.startsWith('/console') ? Console : Muse
document.title = Page === Console ? 'Agent Console' : 'Muse Web'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)

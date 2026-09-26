import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'

// /          admin architecture: platform hub, every lifetime user, live agent-to-agent chats
// /console   the multi-tenant terminal console
const Console = lazy(() => import('./App.tsx'))
const Admin = lazy(() => import('./admin/Admin'))

const Page = location.pathname.startsWith('/console') ? Console : Admin
document.title = Page === Console ? 'Agent Console' : 'Muse Admin'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)

import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// /        the landing page (the story, with a bean walking as you scroll)
// /play    the game
// /avatar  the Bean Studio
// /privacy, /terms  the policies
// /muse    connect your own AI agent (Muse): your personal QR, or the page it opens
const App = lazy(() => import('./App.tsx'))
const AvatarStudio = lazy(() => import('./AvatarStudio').then((m) => ({ default: m.AvatarStudio })))
const Landing = lazy(() => import('./Landing').then((m) => ({ default: m.Landing })))
const MusePage = lazy(() => import('./MusePage').then((m) => ({ default: m.MusePage })))
const Privacy = lazy(() => import('./Legal').then((m) => ({ default: m.Privacy })))
const Terms = lazy(() => import('./Legal').then((m) => ({ default: m.Terms })))

const path = location.pathname
const Page = path.startsWith('/avatar') ? AvatarStudio : path.startsWith('/play') ? App : path.startsWith('/muse') ? MusePage : path.startsWith('/privacy') ? Privacy : path.startsWith('/terms') ? Terms : Landing
// the game and studio are fixed full-screen views; the landing and Muse pages scroll
if (Page === Landing || Page === MusePage || Page === Privacy || Page === Terms) document.documentElement.classList.add('scroll-page')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)

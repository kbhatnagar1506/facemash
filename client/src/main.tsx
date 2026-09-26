import { StrictMode, Suspense, lazy } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'

// /        the landing page (the story, with a bean walking as you scroll)
// /play    the game
// /avatar  the Bean Studio
const App = lazy(() => import('./App.tsx'))
const AvatarStudio = lazy(() => import('./AvatarStudio').then((m) => ({ default: m.AvatarStudio })))
const Landing = lazy(() => import('./Landing').then((m) => ({ default: m.Landing })))

const path = location.pathname
const Page = path.startsWith('/avatar') ? AvatarStudio : path.startsWith('/play') ? App : Landing
// the game and studio are fixed full-screen views; the landing page scrolls
if (Page === Landing) document.documentElement.classList.add('scroll-page')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Suspense fallback={null}>
      <Page />
    </Suspense>
  </StrictMode>,
)

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
// /admin          Aaditi's Muse admin: every agent talk and jev's verdicts, organizers only (?mock=1: local mock)
// /admin/console  her multi-tenant agent console, sample data only, so only with ?demo=1 (else /admin)
const AdminHome = lazy(() => import('./aaditi/admin/Admin'))
const AgentConsole = lazy(() => import('./aaditi/App.tsx'))

const path = location.pathname
const Page = path.startsWith('/avatar') ? AvatarStudio : path.startsWith('/play') ? App : path.startsWith('/muse') ? MusePage : path.startsWith('/privacy') ? Privacy : path.startsWith('/terms') ? Terms : path.startsWith('/admin/console') && new URLSearchParams(location.search).has('demo') ? AgentConsole : path.startsWith('/admin') ? AdminHome : Landing
// the game and studio are fixed full-screen views; the landing and Muse pages scroll
if (Page === AdminHome) document.title = 'Muse Admin'
if (Page === AgentConsole) document.title = 'Agent Console'
if (Page === Landing || Page === MusePage || Page === Privacy || Page === Terms) document.documentElement.classList.add('scroll-page')

// The game and the Bean Studio need an account (no guest mode): signed out, you go back to
// the homepage with the sign-in sheet open. With sign-in off (local dev), nothing changes.
function mount() {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </StrictMode>,
  )
}
if (Page === App || Page === AvatarStudio) {
  import('./account').then(({ fetchMe }) =>
    fetchMe().then((me) => (me.googleClientId && !me.user ? location.replace('/?signin') : mount())),
  )
} else mount()

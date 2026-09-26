import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { AvatarStudio } from './AvatarStudio'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    {location.pathname.startsWith('/avatar') ? <AvatarStudio /> : <App />}
  </StrictMode>,
)

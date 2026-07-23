// MUST be first: installs Buffer/process globals before any SDK module that
// reads them at init time is evaluated (ES import side effects run in order).
import './polyfills'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

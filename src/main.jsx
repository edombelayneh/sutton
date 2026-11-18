import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { AuthGate } from './Auth.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>{(employee, signOut) => <App employee={employee} onSignOut={signOut} />}</AuthGate>
  </StrictMode>,
)

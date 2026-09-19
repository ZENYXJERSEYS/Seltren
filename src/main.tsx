import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './index.css'
import './task-detail.css'
import './task-room.css'
import './messaging.css'
import './enterprise.css'
import './spatial-floor.css'

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { KubecodeApp } from '@/kubecode/App'
import { applyStoredThemeMode } from '@/lib/themeMode'

import './index.css'

applyStoredThemeMode(document, localStorage)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <KubecodeApp />
    </TooltipProvider>
  </StrictMode>,
)

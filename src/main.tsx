import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { KubecodeApp } from '@/kubecode/App'

import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      <KubecodeApp />
    </TooltipProvider>
  </StrictMode>,
)

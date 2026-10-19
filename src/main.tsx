import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { controlMatrixRequest } from '@/components/workspace/controlMatrixRoute'
import { KubecodeApp } from '@/kubecode/App'
import { createTranslator } from '@/lib/i18n'
import { applyStoredThemeMode, applyThemeModeToDocument } from '@/lib/themeMode'

import './index.css'

const ControlMatrix = lazy(async () => ({
  default: (await import('@/components/workspace/ControlMatrix')).ControlMatrix,
}))

const matrix = controlMatrixRequest(window.location.hash)
if (matrix) {
  applyThemeModeToDocument(document, matrix.theme)
  document.documentElement.lang = matrix.locale
}
else applyStoredThemeMode(document, localStorage)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      {matrix ? (
        <Suspense fallback={null}>
          <ControlMatrix t={createTranslator(matrix.locale)} />
        </Suspense>
      ) : (
        <KubecodeApp />
      )}
    </TooltipProvider>
  </StrictMode>,
)

import { StrictMode, lazy, Suspense } from 'react'
import { createRoot } from 'react-dom/client'

import { TooltipProvider } from '@/components/ui/tooltip'
import { controlMatrixRequest } from '@/components/workspace/controlMatrixRoute'
import { prototypeRequest } from '@/components/workspace/prototypes/prototypeRoute'
import { KubecodeApp } from '@/kubecode/App'
import { createTranslator } from '@/lib/i18n'
import { applyStoredThemeMode, applyThemeModeToDocument } from '@/lib/themeMode'

import './index.css'

const ControlMatrix = lazy(async () => ({
  default: (await import('@/components/workspace/ControlMatrix')).ControlMatrix,
}))

const WorkspacePrototypesRoute = lazy(async () => ({
  default: (await import('@/components/workspace/prototypes/WorkspacePrototypes')).WorkspacePrototypesRoute,
}))

const matrix = controlMatrixRequest(window.location.hash)
const prototypes = prototypeRequest(window.location.hash)
const page = matrix ?? prototypes
if (page) {
  applyThemeModeToDocument(document, page.theme)
  document.documentElement.lang = page.locale
}
else applyStoredThemeMode(document, localStorage)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <TooltipProvider>
      {matrix ? (
        <Suspense fallback={null}>
          <ControlMatrix locale={matrix.locale} t={createTranslator(matrix.locale)} />
        </Suspense>
      ) : prototypes ? (
        <Suspense fallback={null}>
          <WorkspacePrototypesRoute initial={prototypes} />
        </Suspense>
      ) : (
        <KubecodeApp />
      )}
    </TooltipProvider>
  </StrictMode>,
)

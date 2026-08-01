import { WorkbenchShell } from './app/WorkbenchShell'
import type { KubecodeApi } from './api'

export function KubecodeApp({ api }: { api?: KubecodeApi }) {
  return <WorkbenchShell api={api} />
}

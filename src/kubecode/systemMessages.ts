import { createContext, useContext } from 'react'

export type SystemMessageLevel = 'debug' | 'info' | 'success' | 'warning' | 'error'

export type SystemMessage = {
  level: SystemMessageLevel
  message: string
  source?: string
}

export type SystemMessageApi = {
  publish: (message: SystemMessage) => void
}

export const SystemMessageContext = createContext<SystemMessageApi | null>(null)

export function useSystemMessages(): SystemMessageApi | null {
  return useContext(SystemMessageContext)
}

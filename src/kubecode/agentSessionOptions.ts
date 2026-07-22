import type { AgentSessionState } from './api'

export type NativeSessionOption = {
  description?: string
  id: string
  name: string
}

export type NativeSessionSelect = {
  category?: string
  currentValue: string
  id: string
  kind: 'config' | 'mode'
  name: string
  options: NativeSessionOption[]
  type: 'select'
}

export type NativeSessionBoolean = {
  currentValue: boolean
  id: string
  kind: 'config'
  name: string
  type: 'boolean'
}

export type NativeSessionConfig = NativeSessionSelect | NativeSessionBoolean

export function nativeSessionOptions(state: AgentSessionState | null): {
  configs: NativeSessionConfig[]
  mode: NativeSessionSelect | null
} {
  const advertisedMode = sessionMode(state)
  const configs = sessionConfigs(state)
  const modeConfigIndex = configs.findIndex((config) => config.type === 'select' && isModeConfig(config))
  const modeConfig = modeConfigIndex >= 0 ? configs[modeConfigIndex] : null
  const mode = advertisedMode ?? (modeConfig?.type === 'select' ? modeConfig : null)
  const modeSignature = advertisedMode ? sessionSelectSignature(advertisedMode) : null
  const ids = new Set<string>()
  if (!advertisedMode && mode) ids.add(mode.id)

  return {
    mode,
    configs: configs.filter((config, index) => {
      if (!advertisedMode && index === modeConfigIndex) return false
      if (ids.has(config.id)) return false
      ids.add(config.id)
      return config.type !== 'select' || !modeSignature || sessionSelectSignature(config) !== modeSignature
    }),
  }
}

function sessionMode(state: AgentSessionState | null): NativeSessionSelect | null {
  const mode = objectValue(state?.current_mode)
  const currentValue = textValue(mode?.currentModeId)
  const options = selectOptions(mode?.availableModes)
  if (!currentValue || options.length === 0) return null
  return { id: 'mode', kind: 'mode', name: 'Mode', currentValue, options, type: 'select' }
}

function sessionConfigs(state: AgentSessionState | null): NativeSessionConfig[] {
  const values = objectValue(state?.config_options)?.configOptions
  if (!Array.isArray(values)) return []
  const configs: NativeSessionConfig[] = []
  for (const value of values) {
    const config = objectValue(value)
    const id = textValue(config?.id)
    const name = textValue(config?.name)
    if (config?.type === 'boolean') {
      if (id && name && typeof config.currentValue === 'boolean') {
        configs.push({ id, kind: 'config', name, currentValue: config.currentValue, type: 'boolean' })
      }
      continue
    }
    if (config?.type !== 'select') continue
    const currentValue = textValue(config.currentValue)
    const options = selectOptions(config.options)
    if (id && name && currentValue && options.length > 0) {
      configs.push({
        id,
        kind: 'config',
        name,
        currentValue,
        options,
        type: 'select',
        category: textValue(config.category),
      })
    }
  }
  return configs
}

function isModeConfig(select: NativeSessionSelect): boolean {
  return select.id.toLowerCase() === 'mode' || select.category?.toLowerCase() === 'mode'
}

function sessionSelectSignature(select: NativeSessionSelect): string {
  return select.options
    .map((option) => `${option.id.trim().toLowerCase()}\u0000${option.name.trim().toLowerCase()}`)
    .sort()
    .join('\u0001')
}

function selectOptions(value: unknown): NativeSessionOption[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const option = objectValue(item)
    const id = textValue(option?.id) || textValue(option?.value)
    if (!id) return []
    const description = textValue(option?.description)
    return [{
      id,
      name: textValue(option?.name) || id,
      ...(description ? { description } : {}),
    }]
  })
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function textValue(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

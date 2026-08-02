export type PreferenceStorage = Pick<Storage, 'getItem' | 'setItem'>

type StoredPreferenceReader = (key: string) => unknown | undefined

type PreferenceStorageOptions<Value, Args extends unknown[]> = {
  defaultValue: (...args: Args) => Value
  key: (...args: Args) => string
  migrate?: (read: StoredPreferenceReader, ...args: Args) => Value | undefined
  normalize: (value: unknown, ...args: Args) => Value | undefined
}

export function createPreferenceStorage<Value, Args extends unknown[] = []>({
  defaultValue,
  key,
  migrate,
  normalize,
}: PreferenceStorageOptions<Value, Args>) {
  return {
    read(storage: PreferenceStorage, ...args: Args): Value {
      const read = (storedKey: string) => readStoredValue(storage, storedKey)
      const normalized = normalize(read(key(...args)), ...args)
      return normalized ?? migrate?.(read, ...args) ?? defaultValue(...args)
    },
    write(storage: PreferenceStorage, value: Value, ...args: Args): void {
      try {
        storage.setItem(key(...args), JSON.stringify(value))
      } catch {
        // Browser storage can be unavailable in restricted contexts.
      }
    },
  }
}

function readStoredValue(storage: PreferenceStorage, key: string): unknown | undefined {
  try {
    const value = storage.getItem(key)
    return value === null ? undefined : JSON.parse(value) as unknown
  } catch {
    return undefined
  }
}

export function query(values: Record<string, string | number | undefined>): string {
  return new URLSearchParams(
    Object.entries(values).flatMap(([key, value]) => (
      value === undefined ? [] : [[key, String(value)]]
    )),
  ).toString()
}

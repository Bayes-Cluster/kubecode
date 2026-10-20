import { useState, type ReactNode } from 'react'

import { createPlaceMemory, PlaceMemoryContext, type PlaceMemory } from './placeMemory'

/**
 * Gives one page's memory of places (ADR 0228 §4) to everything under it: the
 * shell keeps one for its whole life. Without `memory` it makes its own.
 */
export function PlaceMemoryProvider({ children, memory }: { children: ReactNode; memory?: PlaceMemory }) {
  const [own] = useState(createPlaceMemory)
  return <PlaceMemoryContext.Provider value={memory ?? own}>{children}</PlaceMemoryContext.Provider>
}

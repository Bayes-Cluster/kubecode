import { useCoarsePointer } from '../channel/useCoarsePointer'

/**
 * The official SidebarMenuButton size for this pointer: `lg` is the
 * touch-sized row on a coarse pointer, `default` otherwise (ADR 0255).
 */
export function useSidebarMenuSize(): 'default' | 'lg' {
  return useCoarsePointer() ? 'lg' : 'default'
}

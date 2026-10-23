import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { CollapsibleTrigger } from '@/components/ui/collapsible'

/**
 * A folded list's heading in Tasks (#259): the official Collapsible trigger
 * on a ghost Button, its chevron turned while open (still under reduced motion).
 */
export function TaskDisclosure({ children }: { children: ReactNode }) {
  return (
    <CollapsibleTrigger asChild>
      <Button className="group w-full justify-start whitespace-normal text-left" size="sm" variant="ghost">
        <ChevronRight
          aria-hidden
          className="transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
          data-icon="inline-start"
        />
        {children}
      </Button>
    </CollapsibleTrigger>
  )
}

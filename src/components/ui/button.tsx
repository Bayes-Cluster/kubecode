import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

// Kubecode (ADR 0256): the default, sm, lg, icon, icon-sm, icon-lg and wrap
// sizes are 44px touch targets on a coarse pointer; xs and icon-xs (dense rows,
// message actions) and inline keep their own height.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive:
          "bg-destructive text-destructive-foreground hover:bg-destructive/90 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/60",
        outline:
          "border bg-background shadow-xs hover:bg-accent hover:text-accent-foreground dark:bg-input/30 dark:border-input dark:hover:bg-input/50",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost:
          "hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3 pointer-coarse:min-h-[44px]",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 rounded-md gap-1.5 px-3 has-[>svg]:px-2.5 pointer-coarse:min-h-[44px]",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4 pointer-coarse:min-h-[44px]",
        icon: "size-9 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-4",
        "icon-sm": "size-8 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
        "icon-lg": "size-10 pointer-coarse:min-h-[44px] pointer-coarse:min-w-[44px]",
        // Kubecode (ADR 0256): a text decision that wraps a long translation
        // instead of overflowing, and a name that is a link inside running text.
        wrap: "h-auto min-h-8 max-w-full gap-1.5 rounded-md px-3 py-1.5 text-center whitespace-normal has-[>svg]:px-2.5 pointer-coarse:min-h-[44px]",
        inline: "h-auto p-0 text-left whitespace-normal [overflow-wrap:anywhere]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

// eslint-disable-next-line react-refresh/only-export-components -- shadcn/ui pattern
export { Button, buttonVariants }

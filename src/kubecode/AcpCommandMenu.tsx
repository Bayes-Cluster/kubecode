import { Badge } from '@/components/ui/badge'
import { Command, CommandGroup, CommandItem, CommandList } from '@/components/ui/command'

import type { AcpCommand } from './acpCommands'

type AcpCommandMenuProps = {
  commands: AcpCommand[]
  label: string
  onHover: (index: number) => void
  onSelect: (command: AcpCommand) => void
  selectedIndex: number
  unavailableLabel: string
}

function commandKey(command: AcpCommand): string {
  return `${command.providerIndex}:${command.name}`
}

// The composer keeps focus and owns arrow/Enter handling
// (useComposerController.handleCommandKeyDown); the official Command list
// renders the suggestions and mirrors that selection through `value`.
export function AcpCommandMenu({
  commands,
  label,
  onHover,
  onSelect,
  selectedIndex,
  unavailableLabel,
}: AcpCommandMenuProps) {
  const selected = commands[selectedIndex]
  return (
    <Command
      className="kubecode-command-suggestions h-auto rounded-lg border shadow-md"
      label={label}
      shouldFilter={false}
      value={selected ? commandKey(selected) : ''}
      onValueChange={(value) => {
        const index = commands.findIndex((command) => commandKey(command) === value)
        if (index >= 0) onHover(index)
      }}
    >
      <CommandList label={label}>
        <CommandGroup>
          {commands.map((command) => {
            const disabled = command.ambiguous || command.input.kind === 'unsupported'
            return (
              <CommandItem
                disabled={disabled}
                key={commandKey(command)}
                value={commandKey(command)}
                onSelect={() => {
                  if (!disabled) onSelect(command)
                }}
              >
                <code>/{command.name}</code>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{command.description}</span>
                {command.input.kind === 'text' && command.input.hint !== undefined && (
                  <Badge variant="outline">{command.input.hint}</Badge>
                )}
                {disabled && <Badge variant="secondary">{unavailableLabel}</Badge>}
              </CommandItem>
            )
          })}
        </CommandGroup>
      </CommandList>
    </Command>
  )
}

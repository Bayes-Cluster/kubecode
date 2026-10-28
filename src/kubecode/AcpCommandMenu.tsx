import { AgxPickerFill, AgxPickerRow } from '@/components/agent-ui'
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
// renders the suggestions and mirrors that selection through `value`, with
// the shared picker presentation: the fill glides along the selected row.
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
      className="kubecode-command-suggestions h-auto rounded-lg"
      label={label}
      shouldFilter={false}
      value={selected ? commandKey(selected) : ''}
      onValueChange={(value) => {
        const index = commands.findIndex((command) => commandKey(command) === value)
        if (index >= 0) onHover(index)
      }}
    >
      <CommandList className="agx-pick__list" label={label}>
        <AgxPickerFill />
        <CommandGroup>
          {commands.map((command) => {
            const disabled = command.ambiguous || command.input.kind === 'unsupported'
            return (
              <CommandItem
                className="agx-pick__slot"
                disabled={disabled}
                key={commandKey(command)}
                value={commandKey(command)}
                onSelect={() => {
                  if (!disabled) onSelect(command)
                }}
              >
                <AgxPickerRow
                  check={false}
                  hint={command.description}
                  name={<code>/{command.name}</code>}
                />
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

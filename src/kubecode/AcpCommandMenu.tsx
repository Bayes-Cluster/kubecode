import { Button } from '@/components/ui/button'

import type { AcpCommand } from './acpCommands'

type AcpCommandMenuProps = {
  commands: AcpCommand[]
  label: string
  onHover: (index: number) => void
  onSelect: (command: AcpCommand) => void
  selectedIndex: number
  unavailableLabel: string
}

export function AcpCommandMenu({
  commands,
  label,
  onHover,
  onSelect,
  selectedIndex,
  unavailableLabel,
}: AcpCommandMenuProps) {
  return (
    <div aria-label={label} className="kubecode-command-suggestions" role="listbox">
      {commands.map((command, index) => {
        const disabled = command.ambiguous || command.input.kind === 'unsupported'
        return (
          <Button
            aria-disabled={disabled}
            aria-selected={index === selectedIndex}
            className="kubecode-command-suggestion"
            data-selected={index === selectedIndex}
            key={`${command.providerIndex}:${command.name}`}
            onClick={() => {
              if (!disabled) onSelect(command)
            }}
            onPointerMove={() => onHover(index)}
            role="option"
            type="button"
            variant="ghost"
          >
            <code>/{command.name}</code>
            <span className="kubecode-command-description">{command.description}</span>
            {command.input.kind === 'text' && command.input.hint !== undefined && (
              <small className="kubecode-command-hint">{command.input.hint}</small>
            )}
            {disabled && (
              <small className="kubecode-command-hint">{unavailableLabel}</small>
            )}
          </Button>
        )
      })}
    </div>
  )
}

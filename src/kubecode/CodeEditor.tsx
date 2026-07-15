import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { EditorState } from '@codemirror/state'
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'

type CodeEditorProps = {
  content: string
  documentKey: string
  onChange: (content: string) => void
}

export function CodeEditor({ content, documentKey, onChange }: CodeEditorProps) {
  const container = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!container.current) return
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: content,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          highlightSpecialChars(),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          indentOnInput(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          bracketMatching(),
          rectangularSelection(),
          highlightActiveLine(),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          EditorView.lineWrapping,
          EditorView.updateListener.of((update) => {
            if (update.docChanged) onChange(update.state.doc.toString())
          }),
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'var(--surface-editor)' },
            '.cm-scroller': { fontFamily: 'var(--kubecode-code-font)', fontSize: '14px' },
            '.cm-gutters': {
              backgroundColor: 'var(--surface-sidebar)',
              borderColor: 'var(--border-subtle)',
              color: 'var(--text-muted)',
            },
            '.cm-content': { caretColor: 'var(--text-primary)' },
          }),
        ],
      }),
    })
    return () => view.destroy()
  }, [content, documentKey, onChange])

  return <div className="kubecode-code-editor" ref={container} />
}

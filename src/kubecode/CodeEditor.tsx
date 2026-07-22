import { useEffect, useRef } from 'react'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
import { EditorState, Transaction } from '@codemirror/state'
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
  const viewRef = useRef<EditorView>(null)
  const contentRef = useRef(content)
  const onChangeRef = useRef(onChange)
  const synchronizingRef = useRef(false)
  contentRef.current = content
  onChangeRef.current = onChange

  useEffect(() => {
    if (!container.current) return
    const view = new EditorView({
      parent: container.current,
      state: EditorState.create({
        doc: contentRef.current,
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
            if (update.docChanged && !synchronizingRef.current) {
              onChangeRef.current(update.state.doc.toString())
            }
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
    viewRef.current = view
    return () => {
      viewRef.current = null
      view.destroy()
    }
  }, [documentKey])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.doc.toString() === content) return
    synchronizingRef.current = true
    try {
      view.dispatch({
        annotations: Transaction.addToHistory.of(false),
        changes: { from: 0, to: view.state.doc.length, insert: content },
      })
    } finally {
      synchronizingRef.current = false
    }
  }, [content, documentKey])

  return <div className="kubecode-code-editor" ref={container} />
}

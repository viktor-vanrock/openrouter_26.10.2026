import Editor, { loader, type OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import { forwardRef, useImperativeHandle, useRef } from 'react';

const monacoGlobal = self as typeof globalThis & {
  MonacoEnvironment?: { getWorker: (_moduleId: string, label: string) => Worker };
};

monacoGlobal.MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

// Supply the bundled ESM instance to the loader. This prevents its default CDN loader.
loader.config({ monaco });

export type GuideEditorMonacoHandle = { insertSnippet: (snippet: string) => void };

type GuideEditorMonacoProps = {
  value: string;
  onChange: (value: string) => void;
  onSave: () => void;
};

const GuideEditorMonaco = forwardRef<GuideEditorMonacoHandle, GuideEditorMonacoProps>(
  ({ value, onChange, onSave }, ref) => {
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
    const onSaveRef = useRef(onSave);
    onSaveRef.current = onSave;
    useImperativeHandle(ref, () => ({
      insertSnippet: (snippet) => {
        const editor = editorRef.current;
        if (!editor) return;
        const selection = editor.getSelection();
        if (!selection) return;
        editor.executeEdits('guide-media', [
          { range: selection, text: snippet, forceMoveMarkers: true },
        ]);
        editor.focus();
      },
    }));
    const onMount: OnMount = (editor, instance) => {
      editorRef.current = editor;
      editor.addCommand(instance.KeyMod.CtrlCmd | instance.KeyCode.KeyS, () => onSaveRef.current());
    };
    return (
      <Editor
        height="100%"
        language="html"
        theme="vs-dark"
        value={value}
        onChange={(nextValue) => onChange(nextValue ?? '')}
        onMount={onMount}
        options={{
          minimap: { enabled: false },
          wordWrap: 'on',
          fontSize: 14,
          automaticLayout: true,
        }}
      />
    );
  },
);

export default GuideEditorMonaco;

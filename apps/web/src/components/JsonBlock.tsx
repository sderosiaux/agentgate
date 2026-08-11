import type { ReactElement } from 'react';

/**
 * A stored document, shown as stored.
 *
 * The mission scope columns are JSON the gateway reads back through `z.unknown()`, so this
 * console must be able to display a document whose shape it does not recognise instead of
 * throwing on it. `JSON.stringify` returning undefined (a function, a symbol) is handled the
 * same way: say what it is, do not render nothing.
 */
export function JsonBlock({ value, label }: { value: unknown; label?: string }): ReactElement {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = '// this document could not be serialised for display';
  }

  return (
    <div>
      {label === undefined ? null : <div className="eyebrow mb-2">{label}</div>}
      <pre className="bg-sunken border-line text-ink max-h-96 overflow-auto rounded-md border p-3 font-mono text-xs leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

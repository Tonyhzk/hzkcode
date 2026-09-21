/** Card rendered inside the drag-ghost window (?ctx=drag-ghost): a bare label
 *  chip carried by the native follow-the-cursor window while an editor tab is
 *  dragged outside the main window, where DOM content cannot paint. */
export function DragGhostCard({ label }: { label: string }) {
  return (
    <div className="flex h-dvh w-full items-center rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-medium text-text-primary">
      <span className="truncate">{label}</span>
    </div>
  );
}

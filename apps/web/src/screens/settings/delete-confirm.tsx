import { useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { MarginNote } from "@/components/rubrist";
import { deleteProject } from "@/lib/api";
import { useDialogFocus } from "@/hooks/use-dialog-focus";
export function DeleteConfirm({
  projectName,
  onCancel,
  onDeleted
}: {
  projectName: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const pending = useRef(false);
  const [typed, setTyped] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const matches = typed.trim() === projectName;
  const dialogRef = useDialogFocus<HTMLDivElement>({ onClose: onCancel, closeOnEscape: !submitting });

  const submit = async () => {
    if (!matches || pending.current) return;
    pending.current = true;
    setSubmitting(true);
    setError(null);
    try {
      await deleteProject(projectName);
      onDeleted();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      pending.current = false;
      setSubmitting(false);
    }
  };

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-project-title"
      tabIndex={-1}
      className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-ink/40 p-4 sm:items-center"
      onClick={(e) => {
        if (!submitting && e.target === e.currentTarget) onCancel();
      }}
    >
      <Card
        className="max-h-[calc(100dvh-2rem)] w-full max-w-full overflow-y-auto border-signal-tint shadow-elev sm:w-[480px]"
        onClick={(e) => e.stopPropagation()}
      >
        <CardHeader className="border-signal-tint">
          <div>
            <CardTitle id="delete-project-title" className="text-signal">
              Delete {projectName}?
            </CardTitle>
            <CardDescription>
              All traces, verdicts, queues and golden cases will be removed.
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <label htmlFor="delete-project-confirmation" className="text-[12.5px] leading-[1.55] text-ink-2">
            Type the project name to confirm.
          </label>
          <input
            id="delete-project-confirmation"
            autoFocus
            data-dialog-initial-focus
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={projectName}
            className="h-9 rounded-sm border border-rule-soft bg-card-2 px-2 font-mono text-[12.5px] text-ink focus-visible:border-signal"
          />
          <MarginNote tone="signal" who="Irreversible">
            Deleting removes this project's Rubrist review data permanently. It does not delete
            the original runs from your tracing platform.
          </MarginNote>
          {error ? <div role="alert" className="text-[12px] text-signal">{error}</div> : null}
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              Cancel
            </Button>
            <div className="flex-1" />
            <Button
              variant="signal"
              onClick={() => void submit()}
              disabled={!matches || submitting}
            >
              {submitting ? "Deleting…" : "Delete forever"}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

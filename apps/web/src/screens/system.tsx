import { retryableStatus } from "../lib/load-error.js";
import { useLocation, useNavigate } from "react-router-dom";
import { RefreshCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyGlyph, EmptyShell } from "@/components/rubrist";

export function NotFoundScreen() {
  const navigate = useNavigate();
  const location = useLocation();
  return (
    <EmptyShell
      eyebrow="404 · route not found"
      title="That page isn't here."
      body={
        <>
          You may have followed a stale link, deep-linked into a case that has been deleted,
          or hit a route that never existed.
          {location.pathname ? (
            <>
              {" "}The address was <span className="font-mono">{location.pathname}</span>.
            </>
          ) : null}
        </>
      }
      art={<EmptyGlyph kind="404" />}
      primary={
        <Button variant="primary" onClick={() => navigate("/")}>
          Back to overview
        </Button>
      }
      secondary={
        <Button variant="ghost" onClick={() => navigate("/traces")}>
          Search Traces
        </Button>
      }
    />
  );
}

interface ApiUnavailableProps {
  retry?: () => void;
  status?: number | null;
  resource?: string;
  lastOkAt?: string;
}

export function ApiUnavailableScreen({ retry, status, lastOkAt, resource = "this page" }: ApiUnavailableProps) {
  const canRetry = status == null || retryableStatus(status);
  return (
    <EmptyShell
      eyebrow="Data unavailable"
      title={status && status >= 500 ? `Rubrist's server returned an error while loading ${resource}.` : `Couldn't load ${resource}.`}
      body={
        <>
          This read did not change your saved records.{" "}
          {canRetry ? "Try again to load the latest data." : "Check your access or return to the previous page."}
          {lastOkAt ? (
            <>
              {" "}Last successful call <span className="font-mono">{lastOkAt}</span>.
            </>
          ) : null}
        </>
      }
      art={<EmptyGlyph kind="offline" />}
      // EmptyShell truthy-checks the slot, so null is safe and avoids the
      // undefined-vs-omitted mismatch under exactOptionalPropertyTypes.
      primary={
        retry && canRetry ? (
          <Button variant="primary" onClick={retry}>
            <RefreshCcw /> Try again
          </Button>
        ) : null
      }
      secondary={
        <span className="self-center font-mono text-[10.5px] tracking-[0.04em] text-ink-3">
          {status ? `HTTP ${status}` : null}
        </span>
      }
    />
  );
}

// P0-2 error taxonomy: "you're signed in, but this needs a different role" is
// its own state — not a 404, not an API failure.
export function PermissionDeniedScreen({
  requiredRole,
  onBack
}: {
  requiredRole?: string;
  onBack: () => void;
}) {
  return (
    <EmptyShell
      eyebrow="Not authorized"
      title="This action needs an owner."
      body={
        <>
          Your account doesn't have the role this surface requires
          {requiredRole ? (
            <>
              {" "}(<span className="font-mono">{requiredRole}</span>)
            </>
          ) : null}
          . Nothing was changed. Ask a project owner to do this, or to change your role.
        </>
      }
      art={<EmptyGlyph kind="locked" />}
      primary={
        <Button variant="primary" onClick={onBack}>
          Back to overview
        </Button>
      }
    />
  );
}

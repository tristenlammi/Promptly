import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useEffect } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { connectionsApi, type ThingKind } from "@/api/connections";
import { TopNav } from "@/components/layout/TopNav";
import { ErrorState } from "@/components/shared/Callout";

/**
 * ``/link/:kind/:id`` — where a mention points (a doc's link, a message's
 * ``@[Title](/link/…)``). Asks the server where the thing lives *for you*
 * and goes there; someone who can't open it gets a plain "not available"
 * (no title — the label in the text is all they ever see).
 */
export function LinkRedirectPage() {
  const { kind = "", id = "" } = useParams<{ kind: string; id: string }>();
  const navigate = useNavigate();
  const { data, error, isLoading } = useQuery({
    queryKey: ["connections-resolve", kind, id],
    queryFn: () => connectionsApi.resolve({ kind: kind as ThingKind, id }),
    retry: false,
  });
  useEffect(() => {
    if (data?.href) navigate(data.href, { replace: true });
  }, [data, navigate]);

  if (isLoading || data?.href) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-[var(--text-muted)]">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Opening…
      </div>
    );
  }
  return (
    <>
      <TopNav title="Not available" />
      <div className="mx-auto w-full max-w-xl px-4 py-10">
        <ErrorState>
          {error
            ? "This isn’t available — it may have been deleted, or it isn’t shared with you."
            : "This can’t be opened here."}{" "}
          <Link to="/today" className="font-medium underline">
            Back to Today
          </Link>
        </ErrorState>
      </div>
    </>
  );
}

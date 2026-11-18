import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { useRef } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";

import { homeApi } from "@/api/home";
import { homeAutomationsApi } from "@/api/homeAutomations";
import { TopNav } from "@/components/layout/TopNav";
import { confirm } from "@/components/shared/ConfirmDialog";
import { EmptyState } from "@/components/shared/EmptyState";
import { Skeleton } from "@/components/shared/Skeleton";

import { HomeFlowEditor } from "./HomeFlowEditor";

/**
 * One home automation, in its flow editor (``/home/automations/:home/:id``).
 * Anyone in the home can look and run it; whoever looks after the home can
 * change it.
 */
export function HomeAutomationPage() {
  const { homeId = "", autoId = "" } = useParams();
  const homes = useQuery({ queryKey: ["home", "homes"], queryFn: homeApi.homes });
  const auto = useQuery({ queryKey: ["home", "automation", homeId, autoId], queryFn: () => homeAutomationsApi.get(homeId, autoId), retry: false });
  const home = homes.data?.find((h) => h.id === homeId);
  const navigate = useNavigate();
  const dirty = useRef(false);
  const back = (
    <Link
      to="/home"
      onClick={async (e) => {
        // Changes that aren't saved: ask before walking away from them.
        if (!dirty.current) return;
        e.preventDefault();
        if (await confirm({ title: "Leave without saving?", message: "The changes you've made to this automation haven't been saved.", confirmLabel: "Leave", cancelLabel: "Stay" })) navigate("/home");
      }}
      className="inline-flex h-9 items-center gap-1.5 rounded-full border border-[var(--border)] px-3 text-xs font-medium text-[var(--text)] hover:bg-[var(--hover)]"
    >
      <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> Home
    </Link>
  );

  if (homes.isLoading || auto.isLoading) {
    return (
      <>
        <TopNav title="Automation" actions={back} />
        <div className="mx-auto w-full max-w-3xl px-4 py-6">
          <Skeleton className="h-64 rounded-2xl" />
        </div>
      </>
    );
  }
  if (!home || !auto.data) {
    return (
      <>
        <TopNav title="Automation" actions={back} />
        <div className="mx-auto w-full max-w-3xl px-4 py-10">
          <EmptyState title="That automation isn't here" description="It may have been deleted, or it belongs to a home you're not in." />
        </div>
      </>
    );
  }
  return (
    <div className="flex h-full min-h-0 flex-col">
      <TopNav title={auto.data.name} subtitle={auto.data.can_edit ? `${home.name} · automation` : `${home.name} · only the home's owner or a co-owner can change it`} actions={back} />
      <HomeFlowEditor home={home} automation={auto.data} onDirtyChange={(d) => (dirty.current = d)} />
    </div>
  );
}

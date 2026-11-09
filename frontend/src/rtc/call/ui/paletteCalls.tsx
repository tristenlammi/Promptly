/**
 * Ctrl+K rows for calls (Calls WP-D4): "Call Mum", "Video call Sam" for
 * people you can call (by a name you know them by: a contact's name or
 * nickname, a Photos label, or a username), and "Your calls". Blocked
 * people, either way, never come back from the server, so they're never
 * offered; a call to them would be refused anyway.
 */
import { useQuery } from "@tanstack/react-query";
import { Phone, PhoneMissed, Video } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { dmCallsApi, type CallablePerson, type CallMedia } from "@/api/dmCalls";
import type { PaletteAction } from "@/components/chat/usePaletteActions";

import { calls } from "../actions";
import { useCallStore } from "../store";

const VERB = /^(video\s*call|facetime|ring|phone|call)\b\s*(.*)$/i;

/** "call mum" → audio, "mum"; "video call sam" → video, "sam". Exported for tests. */
export function parseCallQuery(query: string): { media: CallMedia; term: string } | null {
  const q = query.trim().replace(/\s+/g, " ");
  const m = VERB.exec(q);
  if (!m) return null;
  return { media: /^(video|facetime)/i.test(m[1]) ? "video" : "audio", term: m[2].trim() };
}

function sameWord(a: string | null | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** "bob" names "e2e_bob" or "Bob Smith": one of its words, whole. */
function namesWord(a: string | null | undefined, b: string): boolean {
  const want = b.trim().toLowerCase();
  return !!a && a.toLowerCase().split(/[\s_.-]+/).includes(want);
}

export function useCallPaletteRows(query: string, navigate: (to: string) => void): PaletteAction[] {
  const available = useCallStore((s) => s.available === true);
  const missed = useCallStore((s) => s.missed);
  const parsed = useMemo(() => parseCallQuery(query), [query]);
  const term = parsed?.term ?? "";
  // Ask once typing pauses, not on every letter.
  const [asked, setAsked] = useState(term);
  useEffect(() => {
    const t = window.setTimeout(() => setAsked(term), 150);
    return () => window.clearTimeout(t);
  }, [term]);
  const { data, isFetched } = useQuery({
    queryKey: ["calls", "people", "q", asked],
    queryFn: () => dmCallsApi.people(asked),
    enabled: available && asked.length >= 1 && asked === term,
    staleTime: 30_000,
  });

  return useMemo(() => {
    const out: PaletteAction[] = [];
    if (!available) return out;
    const q = query.trim().toLowerCase();
    if (parsed && term) {
      const media = parsed.media;
      const Icon = media === "video" ? Video : Phone;
      const verb = media === "video" ? "Video call" : "Call";
      const people: CallablePerson[] = data ?? [];
      people.slice(0, 4).forEach((p, i) => {
        const shown = p.said ?? p.name;
        const exact =
          sameWord(p.said, term) || sameWord(p.name, term) || namesWord(p.name, term) || namesWord(p.user.username, term);
        out.push({
          key: `call-${media}-${p.user.id}`,
          icon: <Icon className="h-4 w-4" />,
          title: `${verb} ${shown}`,
          detail: [shown !== p.name ? p.name : null, `@${p.user.username}`, media === "video" ? "Video call on Promptly" : "Voice call on Promptly"]
            .filter(Boolean)
            .join(" · "),
          // Said outright and only one person it can be: Enter calls.
          sure: i === 0 && exact && people.length === 1,
          group: "Calls",
          run: async () => {
            void calls.startWith([p.user.id], media);
            return true;
          },
        });
      });
      if (isFetched && people.length === 0 && term.length >= 2) {
        out.push({
          key: `call-none-${media}`,
          icon: <Icon className="h-4 w-4" />,
          title: `${verb} ${parsed.term}`,
          detail: `No one called “${parsed.term}” you can call`,
          sure: false,
          group: "Calls",
          run: async () => false,
        });
      }
    }
    if (q.length >= 3 && ("calls".startsWith(q) || "missed calls".startsWith(q) || q === "call history")) {
      out.push({
        key: "calls-open",
        icon: <PhoneMissed className="h-4 w-4" />,
        title: "Your calls",
        detail: missed > 0 ? `${missed} missed · Rooms › Calls` : "Call history · Rooms › Calls",
        sure: false,
        group: "Calls",
        run: async () => {
          navigate("/rooms/calls");
          return true;
        },
      });
    }
    return out;
  }, [available, query, parsed, term, data, isFetched, missed, navigate]);
}

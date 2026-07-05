import { useCallback, useEffect, useState } from "react";
import {
  FlaskConical,
  Globe,
  Loader2,
  Plus,
  Star,
  Trash2,
} from "lucide-react";

import {
  searchApi,
  type SearchProviderRow,
  type SearchProviderType,
} from "@/api/search";
import { Button } from "@/components/shared/Button";
import { Modal } from "@/components/shared/Modal";
import { extractError } from "@/components/files/helpers";
import { toast } from "@/store/toastStore";
import { cn } from "@/utils/cn";

/**
 * Admin management for web-search providers — the top section of the
 * Connectors tab. The backend supports SearXNG (self-hosted scraper),
 * Tavily / Brave (API key), and Google PSE (key + cx). With more than
 * one enabled provider the chat/agents/automations search path fails
 * over automatically when the primary errors or returns nothing, so
 * the recommended setup is SearXNG + one API provider.
 */

const TYPE_INFO: Record<
  SearchProviderType,
  { label: string; hint: string; needsKey: boolean }
> = {
  tavily: {
    label: "Tavily",
    hint: "API key from tavily.com — 1,000 free searches/month, no card. Recommended fallback (or primary).",
    needsKey: true,
  },
  searxng: {
    label: "SearXNG",
    hint: "Base URL of a self-hosted SearXNG instance (free, but upstream engines can rate-limit it).",
    needsKey: false,
  },
  brave: {
    label: "Brave Search",
    hint: "API key from brave.com/search/api — paid plans with a small monthly credit.",
    needsKey: true,
  },
  google_pse: {
    label: "Google PSE",
    hint: "Closed to new signups and sunsets Jan 2027 — only use an existing key + Search Engine ID.",
    needsKey: true,
  },
};

export function SearchProvidersPanel() {
  const [rows, setRows] = useState<SearchProviderRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<{
    id: string;
    ok: boolean;
    text: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRows(await searchApi.list());
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const onToggle = async (p: SearchProviderRow) => {
    setBusyId(p.id);
    try {
      await searchApi.update(p.id, { enabled: !p.enabled });
      await load();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusyId(null);
    }
  };

  const onMakeDefault = async (p: SearchProviderRow) => {
    setBusyId(p.id);
    try {
      await searchApi.update(p.id, { is_default: true });
      await load();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusyId(null);
    }
  };

  const onDelete = async (p: SearchProviderRow) => {
    if (!window.confirm(`Delete search provider "${p.name}"?`)) return;
    setBusyId(p.id);
    try {
      await searchApi.remove(p.id);
      await load();
    } catch (e) {
      toast.error(extractError(e));
    } finally {
      setBusyId(null);
    }
  };

  const onTest = async (p: SearchProviderRow) => {
    setBusyId(p.id);
    setTestResult(null);
    try {
      const res = await searchApi.test(p.id, "current weather forecast");
      setTestResult({
        id: p.id,
        ok: res.results.length > 0,
        text:
          res.results.length > 0
            ? `${res.results.length} result(s) — "${res.results[0].title}"`
            : "Reachable, but returned 0 results (upstream engines may be rate-limiting it).",
      });
    } catch (e) {
      setTestResult({ id: p.id, ok: false, text: extractError(e) });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section>
      <div className="mb-4 flex items-center justify-between gap-3">
        <p className="max-w-xl text-sm text-[var(--text-muted)]">
          Providers that power <code>web_search</code> in chats, research
          agents, and automations. With more than one enabled, searches
          automatically fail over when the default errors or returns
          nothing.
        </p>
        <Button
          variant="primary"
          size="sm"
          leftIcon={<Plus className="h-3.5 w-3.5" />}
          onClick={() => setAdding(true)}
        >
          Add provider
        </Button>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-6 text-sm text-[var(--text-muted)]">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading providers…
        </div>
      ) : rows.length === 0 ? (
        <div className="rounded-card border border-dashed border-[var(--border)] px-6 py-8 text-center text-sm text-[var(--text-muted)]">
          No search providers configured — web search is unavailable until
          one is added.
        </div>
      ) : (
        <ul className="overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
          {rows.map((p, i) => (
            <li
              key={p.id}
              className={cn(
                "px-4 py-3",
                i > 0 && "border-t border-[var(--border)]"
              )}
            >
              <div className="flex flex-wrap items-center gap-2">
                <Globe className="h-4 w-4 shrink-0 text-[var(--text-muted)]" />
                <span className="text-sm font-medium">{p.name}</span>
                <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                  {TYPE_INFO[p.type]?.label ?? p.type}
                </span>
                {p.is_default && (
                  <span className="inline-flex items-center gap-1 rounded bg-[var(--accent)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--accent)]">
                    <Star className="h-2.5 w-2.5" /> default
                  </span>
                )}
                {!p.enabled && (
                  <span className="rounded bg-[var(--text-muted)]/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-[var(--text-muted)]">
                    disabled
                  </span>
                )}

                <div className="ml-auto flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === p.id}
                    leftIcon={
                      busyId === p.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <FlaskConical className="h-3.5 w-3.5" />
                      )
                    }
                    onClick={() => void onTest(p)}
                  >
                    Test
                  </Button>
                  {!p.is_default && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busyId === p.id}
                      onClick={() => void onMakeDefault(p)}
                    >
                      Make default
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busyId === p.id}
                    onClick={() => void onToggle(p)}
                  >
                    {p.enabled ? "Disable" : "Enable"}
                  </Button>
                  <button
                    type="button"
                    title="Delete"
                    aria-label={`Delete ${p.name}`}
                    disabled={busyId === p.id}
                    onClick={() => void onDelete(p)}
                    className="rounded-md p-1.5 text-[var(--text-muted)] transition hover:bg-red-500/10 hover:text-red-500"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
              {testResult?.id === p.id && (
                <p
                  className={cn(
                    "mt-2 text-xs",
                    testResult.ok
                      ? "text-[var(--text-muted)]"
                      : "text-[var(--warning)]"
                  )}
                >
                  {testResult.text}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <AddProviderModal
        open={adding}
        onClose={() => setAdding(false)}
        onCreated={() => {
          setAdding(false);
          void load();
        }}
      />
    </section>
  );
}

function AddProviderModal({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [type, setType] = useState<SearchProviderType>("tavily");
  const [name, setName] = useState("Tavily");
  const [apiKey, setApiKey] = useState("");
  const [url, setUrl] = useState("");
  const [cx, setCx] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const info = TYPE_INFO[type];

  const pickType = (t: SearchProviderType) => {
    setType(t);
    setName(TYPE_INFO[t].label);
  };

  const submit = async () => {
    setErr(null);
    const config: Record<string, unknown> = {};
    if (info.needsKey) {
      if (!apiKey.trim()) {
        setErr("An API key is required for this provider.");
        return;
      }
      config.api_key = apiKey.trim();
    }
    if (type === "searxng") {
      if (!url.trim()) {
        setErr("The SearXNG base URL is required.");
        return;
      }
      config.url = url.trim();
    }
    if (type === "google_pse") {
      if (!cx.trim()) {
        setErr("Google PSE needs the Search Engine ID (cx).");
        return;
      }
      config.cx = cx.trim();
    }
    setBusy(true);
    try {
      // Admin surface → system scope: the provider serves every
      // account (and joins everyone's failover chain), not just the
      // admin's own.
      await searchApi.create({
        name: name.trim() || info.label,
        type,
        config,
        is_default: makeDefault,
        enabled: true,
        scope: "system",
      });
      toast.success(`Added ${name.trim() || info.label}`);
      setApiKey("");
      setUrl("");
      setCx("");
      setMakeDefault(false);
      onCreated();
    } catch (e) {
      setErr(extractError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Add search provider"
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" size="sm" onClick={submit} loading={busy}>
            Add
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(TYPE_INFO) as SearchProviderType[]).map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => pickType(t)}
              className={cn(
                "rounded-md border px-2.5 py-1 text-xs transition",
                t === type
                  ? "border-[var(--accent)] bg-[var(--accent)]/10 text-[var(--text)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]"
              )}
            >
              {TYPE_INFO[t].label}
            </button>
          ))}
        </div>
        <p className="text-xs text-[var(--text-muted)]">{info.hint}</p>

        <label className="block text-sm">
          <span className="mb-1 block text-[var(--text-muted)]">Name</span>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
          />
        </label>

        {info.needsKey && (
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--text-muted)]">API key</span>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="tvly-…"
              autoComplete="off"
              className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        )}

        {type === "searxng" && (
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--text-muted)]">
              Base URL
            </span>
            <input
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="http://searxng:8080"
              className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        )}

        {type === "google_pse" && (
          <label className="block text-sm">
            <span className="mb-1 block text-[var(--text-muted)]">
              Search Engine ID (cx)
            </span>
            <input
              type="text"
              value={cx}
              onChange={(e) => setCx(e.target.value)}
              className="w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] focus:border-[var(--accent)] focus:outline-none"
            />
          </label>
        )}

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={makeDefault}
            onChange={(e) => setMakeDefault(e.target.checked)}
            className="accent-[var(--accent)]"
          />
          <span>
            Make this the default provider{" "}
            <span className="text-[var(--text-muted)]">
              (others stay available as automatic fallbacks)
            </span>
          </span>
        </label>

        {err && (
          <p className="text-sm text-red-600 dark:text-red-400">{err}</p>
        )}
      </div>
    </Modal>
  );
}

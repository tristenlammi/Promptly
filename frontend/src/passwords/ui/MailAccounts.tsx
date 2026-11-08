// "Accounts not in your vault": sites your mail says you have accounts with, and no
// login for here. The server finds them in your mail; the comparison with the vault, and
// what you decide about each, happen on this device and stay in the vault.
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  accountsNotInVault,
  type AccountRow,
  composeHref,
  deletionEmail,
  deletionLinks,
  KIND_TEXT,
  loginFor,
  type MailSites,
  openHref,
  prefsBody,
  readPrefs,
  type SiteState,
  withSiteState,
} from "../core/accounts";
import { ItemEditor } from "./ItemEditor";
import { Button, Callout, errorText, Modal, safeHref, useVault } from "./kit";

const SHOWN = 25;

function day(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function MailAccounts() {
  const { vault, platform, version, bump, toast } = useVault();
  const [data, setData] = useState<MailSites | null>(null);
  const [vid, setVid] = useState<string | null>(null);
  const [adding, setAdding] = useState<AccountRow | null>(null);
  const [deleting, setDeleting] = useState<AccountRow | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    void vault.api.request<MailSites>("GET", "/mail/accounts").then(setData).catch(() => undefined);
    void vault.personalVaultId().then(setVid).catch(() => undefined);
  }, [vault]);

  const rows = useMemo(() => {
    void version;
    if (!data) return [];
    const { prefs } = readPrefs(vault.allItems({ includeSystem: true }), vid);
    return accountsNotInVault(data.sites, vault.allItems(), prefs);
  }, [data, vault, vid, version]);

  const mark = useCallback(
    async (domain: string, state: SiteState["state"] | null, said: string) => {
      try {
        const personal = vid ?? (await vault.personalVaultId());
        const { item, prefs } = readPrefs(vault.allItems({ includeSystem: true }), personal);
        const body = prefsBody(item?.body ?? null, withSiteState(prefs, domain, state));
        if (item) await vault.update(item.id, body);
        else await vault.saveNew(personal, body);
        vault.sync().catch(() => undefined);
        bump();
        toast(said);
      } catch (e) {
        toast(errorText(e), "err");
      }
    },
    [vault, vid, bump, toast],
  );

  if (!data || !data.mail) return null;
  const base = platform.baseUrl;
  return (
    <section data-testid="mail-accounts" className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <h2 className="text-sm font-semibold text-[var(--text)]">
        Accounts not in your vault <span data-testid="count-mail-accounts" className="ml-1 rounded bg-[var(--surface-1)] px-1.5 text-xs">{rows.length}</span>
      </h2>
      <p className="mb-1 text-xs text-[var(--text-muted)]">
        Sites your email says you have an account with, and no login here. Your server finds them in your mail. It never sees your vault: the comparison is done on this device.
        {!data.complete && " Still reading older mail, so more may turn up."}
      </p>
      {rows.length > 0 && (
        <ul>
          {(all ? rows : rows.slice(0, SHOWN)).map((row) => {
            const site = row.sites[0];
            const mail = openHref(base, site.open);
            const addresses = [...new Set(row.sites.map((s) => s.address))];
            return (
              <li key={row.domain} data-testid={`mail-account-${row.domain}`} className="flex flex-col gap-1 border-b border-[var(--border)] py-2 text-sm text-[var(--text)] last:border-0">
                <div className="flex flex-wrap items-baseline gap-x-2">
                  <span className="font-medium">{row.domain}</span>
                  {row.state?.state === "deleting" && <span className="rounded bg-[var(--surface-1)] px-1.5 text-xs">Deleting</span>}
                  <span className="text-xs text-[var(--text-muted)]">{addresses.join(", ")}</span>
                </div>
                <div className="text-xs text-[var(--text-muted)]">
                  {row.kinds.map((k) => KIND_TEXT[k]).join(", ")} · first {day(row.firstSeen)}, last {day(row.lastSeen)}
                  {mail && (
                    <>
                      {" · "}
                      <a className="underline" href={mail} target="_blank" rel="noopener noreferrer">Open the email</a>
                    </>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  {row.state?.state === "deleting" ? (
                    <>
                      <Button small onClick={() => setDeleting(row)}>How to delete it</Button>
                      <Button small onClick={() => mark(row.domain, "gone", `${row.domain}: marked as gone`)}>It's gone</Button>
                      <Button small onClick={() => mark(row.domain, null, `${row.domain}: kept`)}>I'm keeping it</Button>
                    </>
                  ) : (
                    <>
                      <Button small onClick={() => setAdding(row)}>Add login</Button>
                      <Button small onClick={() => setDeleting(row)}>Delete account…</Button>
                      <Button small onClick={() => mark(row.domain, "hidden", `${row.domain} won't be shown again`)}>Not an account</Button>
                    </>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {!all && rows.length > SHOWN && <Button small className="mt-2" onClick={() => setAll(true)}>Show all {rows.length}</Button>}
      {adding && vid && (
        <Modal title={`Add a login for ${adding.domain}`} onClose={() => setAdding(null)} wide>
          <ItemEditor
            vaultId={vid}
            initial={loginFor(adding)}
            onCancel={() => setAdding(null)}
            onDone={() => {
              setAdding(null);
              vault.sync().catch(() => undefined);
              bump();
              toast("Saved");
            }}
          />
        </Modal>
      )}
      {deleting && (
        <DeleteHelp
          row={deleting}
          baseUrl={base}
          onClose={() => setDeleting(null)}
          onDeleting={() => {
            void mark(deleting.domain, "deleting", `${deleting.domain}: marked as deleting`);
            setDeleting(null);
          }}
        />
      )}
    </section>
  );
}

const DIFFICULTY: Record<string, string> = {
  easy: "Easy: there's a page or button for it.",
  medium: "Some extra steps.",
  hard: "Hard: you may have to contact them.",
  limited: "Only possible for some people or places.",
  impossible: "They say it can't be deleted. Asking them by email may still work.",
};

function DeleteHelp({ row, baseUrl, onClose, onDeleting }: { row: AccountRow; baseUrl: string; onClose: () => void; onDeleting: () => void }) {
  const links = deletionLinks(row);
  const email = deletionEmail(row);
  const known = links.known ? safeHref(links.known) : undefined;
  const settings = safeHref(links.settings);
  return (
    <Modal title={`Delete your ${row.domain} account`} onClose={onClose}>
      <div data-testid="delete-help" className="flex flex-col gap-3 text-sm text-[var(--text)]">
        <p>Delete it on the site if you can. If you can't, ask them by email.</p>
        <ol className="flex list-decimal flex-col gap-2 pl-5">
          {known ? (
            <li>
              <a className="underline" href={known} target="_blank" rel="noopener noreferrer">Their account deletion page</a>
              {links.difficulty && DIFFICULTY[links.difficulty] && <span className="text-xs text-[var(--text-muted)]"> {DIFFICULTY[links.difficulty]}</span>}
            </li>
          ) : null}
          {settings && (
            <li>
              <a className="underline" href={settings} target="_blank" rel="noopener noreferrer">Their account settings</a>
              <span className="text-xs text-[var(--text-muted)]"> Deleting an account is usually in there, near the bottom.</span>
            </li>
          )}
          <li>
            <a className="underline" href={composeHref(baseUrl, email)} target="_blank" rel="noopener noreferrer">Write a deletion request in Mail</a>
            <span className="text-xs text-[var(--text-muted)]"> It opens as a draft to {email.to}. Nothing is sent until you press Send.</span>
          </li>
        </ol>
        {email.guessed && <Callout kind="warn">{email.to} is a guess. Check the site's privacy policy for the right address before you send it.</Callout>}
        <div className="flex flex-wrap gap-2">
          <Button kind="primary" onClick={onDeleting}>Mark as deleting</Button>
          <Button onClick={onClose}>Close</Button>
        </div>
        <p className="text-xs text-[var(--text-muted)]">It stays on the list, marked, until you say it's gone.{known ? " Deletion pages from JustDeleteMe (justdeleteme.xyz), MIT licence." : ""}</p>
      </div>
    </Modal>
  );
}

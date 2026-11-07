// Shared vaults and emergency access. Whoever you share with is chosen from the people
// on this Promptly; compare safety words with them to be sure the server isn't in between.
import { useCallback, useEffect, useState } from "react";

import type { MemberOut } from "../core/api";
import type { Item } from "../core/model";
import { type EmergencyOut, KeyChangedError, type VaultInfo } from "../core/vault";
import { KeyChanges, VaultIconsToggle } from "./Connections";
import { Button, Callout, errorText, inputClass, Label, Modal, useVault } from "./kit";

type Person = { id: string; username: string; has_vault: boolean };

const ROLE_TEXT: Record<string, string> = {
  view: "Can view",
  fill: "Can fill only (can't reveal)",
  edit: "Can edit",
  manage: "Can manage",
};

export function SharedScreen() {
  const { vault, version, bump, toast } = useVault();
  const [vaults, setVaults] = useState<VaultInfo[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [myWords, setMyWords] = useState<string[]>([]);
  const [making, setMaking] = useState<string | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setVaults((await vault.vaults()).filter((v) => v.kind === "shared"));
      setPeople(await vault.api.request<Person[]>("GET", "/people"));
      setMyWords(await vault.myIdentityWords());
      setError("");
    } catch (e) {
      setError(errorText(e));
    }
  }, [vault]);
  // A sync changes the version, so syncing on every version would never stop.
  useEffect(() => {
    void vault.sync().catch(() => undefined).then(load);
  }, [vault, load]);
  useEffect(() => {
    void load();
  }, [load, version]);

  const invited = vaults.filter((v) => !v.accepted);
  const mine = vaults.filter((v) => v.accepted);
  const others = people.filter((p) => p.has_vault);

  return (
    <section className="flex max-w-3xl flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-lg font-semibold text-[var(--text)]">Shared vaults</h1>
        <Button kind="primary" onClick={() => setMaking("")}>New vault</Button>
      </div>
      {error && <Callout kind="danger">{error}</Callout>}
      {myWords.length > 0 && (
        <p className="text-xs text-[var(--text-muted)]">
          Your safety words: <span data-testid="my-words" className="font-mono text-[var(--text)]">{myWords.join(" ")}</span>. Someone sharing with you can compare these with what their screen says, in person or by phone.
        </p>
      )}

      <KeyChanges onChange={load} />

      {invited.map((v) => (
        <Invitation key={v.id} v={v} onDone={load} />
      ))}

      {mine.length === 0 && people.length > 0 && (
        <Callout>
          <p className="mb-2">There are other people on this Promptly. A shared vault is a good place for the household's logins, like streaming or the Wi-Fi.</p>
          <Button small onClick={() => setMaking("Family")}>Make a Family vault</Button>
        </Callout>
      )}

      {mine.map((v) => (
        <VaultCard key={v.id} v={v} people={others} onChange={async () => { bump(); await load(); }} />
      ))}

      <EmergencyPanel people={others} onChange={load} />

      {making !== null && (
        <NewVault
          initial={making}
          onClose={() => setMaking(null)}
          onMade={async (name) => {
            try {
              await vault.createSharedVault(name);
              toast("Vault made");
              setMaking(null);
              bump();
              await load();
            } catch (e) {
              toast(errorText(e), "err");
            }
          }}
        />
      )}
    </section>
  );
}

function NewVault({ initial, onClose, onMade }: { initial: string; onClose: () => void; onMade: (name: string) => Promise<void> }) {
  const [name, setName] = useState(initial);
  return (
    <Modal title="New shared vault" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <Label text="Name" hint="Encrypted. The server can't read it.">
          <input className={inputClass} value={name} autoFocus onChange={(e) => setName(e.target.value)} maxLength={80} />
        </Label>
        <Button kind="primary" disabled={!name.trim()} onClick={() => onMade(name.trim())}>Make vault</Button>
      </div>
    </Modal>
  );
}

function Invitation({ v, onDone }: { v: VaultInfo; onDone: () => Promise<void> }) {
  const { vault, toast } = useVault();
  const [words, setWords] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [odd, setOdd] = useState(false);
  useEffect(() => {
    if (!v.grantedBy) return;
    vault
      .inviterInfo(v.grantedBy)
      .then((i) => {
        setWords(i.words);
        setFrom(i.username);
        setOdd(i.twin || i.changed);
      })
      .catch(() => undefined);
  }, [vault, v.grantedBy]);
  return (
    <div data-testid="invitation" className="flex flex-col gap-2 rounded-lg border border-[var(--accent)] p-3">
      <p className="text-sm font-medium text-[var(--text)]">{from || "Someone"} shared a vault with you</p>
      {odd && <Callout kind="danger">You already know someone by this name, with different keys. This might not be who it says. Check with them directly before accepting.</Callout>}
      {words.length > 0 && <p className="text-xs text-[var(--text-muted)]">Their safety words should be <span className="font-mono text-[var(--text)]">{words.join(" ")}</span>. If you can, check with them before accepting.</p>}
      <div className="flex gap-2">
        <Button
          small
          kind="primary"
          onClick={async () => {
            try {
              if (odd && v.grantedBy) await vault.acceptChangedKey(v.grantedBy);
              await vault.acceptVault(v.id);
              toast("Vault added");
              await onDone();
            } catch (e) {
              toast(errorText(e), "err");
            }
          }}
        >
          Accept
        </Button>
        <Button
          small
          onClick={async () => {
            try {
              await vault.api.leaveVault(v.id);
              await vault.sync();
              await onDone();
            } catch (e) {
              toast(errorText(e), "err");
            }
          }}
        >
          Decline
        </Button>
      </div>
    </div>
  );
}

function VaultCard({ v, people, onChange }: { v: VaultInfo; people: Person[]; onChange: () => Promise<void> }) {
  const { vault, toast, go } = useVault();
  const [members, setMembers] = useState<MemberOut[]>([]);
  const [adding, setAdding] = useState("");
  const [role, setRole] = useState("view");
  const [wordsFor, setWordsFor] = useState<MemberOut | null>(null);
  const [removing, setRemoving] = useState<MemberOut | null>(null);
  // Who the new key goes to, shown before it goes. null removing and a plan means "just change the key".
  const [rotating, setRotating] = useState(false);
  const [plan, setPlan] = useState<Awaited<ReturnType<typeof vault.rotationPlan>>>([]);
  const [toChange, setToChange] = useState<Item[] | null>(null);
  const [changedKey, setChangedKey] = useState<KeyChangedError | null>(null);
  const [error, setError] = useState("");
  const manager = v.role === "manage";

  const loadMembers = useCallback(async () => {
    try {
      setMembers(await vault.api.members(v.id));
    } catch (e) {
      setError(errorText(e));
    }
  }, [vault, v.id]);
  useEffect(() => {
    void loadMembers();
  }, [loadMembers]);

  const add = async () => {
    setError("");
    try {
      await vault.addMember(v.id, adding, role);
      toast("Invitation sent");
      setAdding("");
      await loadMembers();
      await onChange();
    } catch (e) {
      if (e instanceof KeyChangedError) setChangedKey(e);
      else setError(errorText(e));
    }
  };

  const available = people.filter((p) => !members.some((m) => m.user_id === p.id));

  return (
    <article data-testid="shared-vault" className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-medium text-[var(--text)]">{v.displayName}</h2>
          <p className="text-xs text-[var(--text-muted)]">{ROLE_TEXT[v.role] ?? v.role}</p>
        </div>
        <div className="flex gap-2">
          <Button small onClick={() => go(`vault/${v.id}`)}>Items</Button>
          <Button
            small
            onClick={async () => {
              if (!confirm(`Leave ${v.displayName}? You won't be able to read it after this.`)) return;
              try {
                await vault.api.leaveVault(v.id);
                await vault.sync();
                await onChange();
              } catch (e) {
                toast(errorText(e), "err");
              }
            }}
          >
            Leave
          </Button>
          {manager && (
            <Button
              small
              onClick={async () => {
                if (!confirm(`Delete ${v.displayName} and everything in it, for everyone?`)) return;
                try {
                  await vault.api.deleteVault(v.id);
                  await vault.sync();
                  await onChange();
                } catch (e) {
                  toast(errorText(e), "err");
                }
              }}
            >
              Delete
            </Button>
          )}
        </div>
      </div>

      <ul className="flex flex-col gap-1">
        {members.map((m) => (
          <li key={m.user_id} data-testid="member-row" className="flex flex-wrap items-center gap-2 text-sm text-[var(--text)]">
            <span className="min-w-0 flex-1 truncate">
              {m.username}
              {!m.accepted && <span className="text-[var(--text-muted)]"> (invited)</span>}
            </span>
            {manager ? (
              <select
                aria-label={`Role for ${m.username}`}
                className={`${inputClass} w-auto py-1 text-xs`}
                value={m.role}
                onChange={async (e) => {
                  try {
                    await vault.api.setRole(v.id, m.user_id, e.target.value);
                    await loadMembers();
                  } catch (err) {
                    toast(errorText(err), "err");
                  }
                }}
              >
                {Object.entries(ROLE_TEXT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
              </select>
            ) : (
              <span className="text-xs text-[var(--text-muted)]">{ROLE_TEXT[m.role] ?? m.role}</span>
            )}
            <Button small onClick={() => setWordsFor(m)}>Safety words</Button>
            {manager && (
              <Button
                small
                onClick={async () => {
                  setPlan(await vault.rotationPlan(v.id, [m.user_id]));
                  setRemoving(m);
                }}
              >
                Remove
              </Button>
            )}
          </li>
        ))}
      </ul>

      {manager && (
        <div className="flex flex-wrap items-end gap-2">
          <Label text="Add someone">
            <select className={inputClass} value={adding} onChange={(e) => setAdding(e.target.value)} data-testid="add-person">
              <option value="">Choose someone</option>
              {available.map((p) => <option key={p.id} value={p.id}>{p.username}</option>)}
            </select>
          </Label>
          <Label text="They can">
            <select className={inputClass} value={role} onChange={(e) => setRole(e.target.value)}>
              {Object.entries(ROLE_TEXT).map(([k, t]) => <option key={k} value={k}>{t}</option>)}
            </select>
          </Label>
          <Button disabled={!adding} onClick={add}>Invite</Button>
        </div>
      )}
      {manager && <VaultIconsToggle vaultId={v.id} />}
      {manager && role === "fill" && <p className="text-xs text-[var(--text-muted)]">Fill only is a convenience, not a lock: their browser holds the password to fill it, so someone determined could still get at it.</p>}
      {error && <Callout kind="danger">{error}</Callout>}

      {manager && v.rotateNeeded && (
        <Callout kind="warn">
          <p className="mb-2">Someone who could read this vault has gone, and it still has the key they knew. Change it, so nothing new can be read with that key.</p>
          <Button
            small
            onClick={async () => {
              setPlan(await vault.rotationPlan(v.id, []));
              setRotating(true);
            }}
          >
            Change the key
          </Button>
        </Callout>
      )}
      {rotating && (
        <Modal title="Change this vault's key" onClose={() => setRotating(false)}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text)]">Everything in it gets encrypted again, on this device.</p>
            <Recipients plan={plan} />
            <Button
              kind="primary"
              onClick={async () => {
                try {
                  const list = await vault.removeMembers(v.id, [], plan.filter((p) => !p.known).map((p) => p.userId));
                  setRotating(false);
                  setToChange(list);
                  await loadMembers();
                  await onChange();
                } catch (e) {
                  setRotating(false);
                  setError(errorText(e));
                }
              }}
            >
              Change the key
            </Button>
          </div>
        </Modal>
      )}
      {wordsFor && <SafetyWords member={wordsFor} onClose={() => setWordsFor(null)} />}
      {changedKey && (
        <Modal title="Their keys have changed" onClose={() => setChangedKey(null)}>
          <div className="flex flex-col gap-3">
            <Callout kind="danger">{changedKey.username || "This person"}'s keys aren't the ones you saw before. They may have reset their vault, or something may be wrong with the server. Check with them directly before going on.</Callout>
            <Button
              onClick={async () => {
                await vault.acceptChangedKey(changedKey.userId);
                setChangedKey(null);
                toast("Saved. Compare safety words with them.");
              }}
            >
              I've checked, use the new keys
            </Button>
          </div>
        </Modal>
      )}
      {removing && (
        <Modal title={`Remove ${removing.username}?`} onClose={() => setRemoving(null)}>
          <div className="flex flex-col gap-3">
            <p className="text-sm text-[var(--text)]">The vault gets a new key and everything in it is encrypted again, on this device. This can take a moment.</p>
            <Callout kind="warn">They may have copied what they could see, and no key change undoes that. You'll get a list of passwords to change.</Callout>
            <Recipients plan={plan} />
            <Button
              kind="primary"
              onClick={async () => {
                try {
                  const list = await vault.removeMembers(v.id, [removing.user_id], plan.filter((p) => !p.known).map((p) => p.userId));
                  setRemoving(null);
                  setToChange(list);
                  await loadMembers();
                  await onChange();
                } catch (e) {
                  setRemoving(null);
                  setError(errorText(e));
                }
              }}
            >
              Remove and change the key
            </Button>
          </div>
        </Modal>
      )}
      {toChange && (
        <Modal title="Passwords to change" onClose={() => setToChange(null)}>
          <div className="flex flex-col gap-3">
            {toChange.length === 0 ? (
              <p className="text-sm text-[var(--text)]">Nothing with a password was in this vault.</p>
            ) : (
              <>
                <p className="text-sm text-[var(--text)]">They could read these. Change them on each site when you can.</p>
                <ul data-testid="to-change" className="list-disc pl-5 text-sm text-[var(--text)]">
                  {toChange.map((i) => <li key={i.id}>{i.body.title}</li>)}
                </ul>
              </>
            )}
            <Button onClick={() => setToChange(null)}>Done</Button>
          </div>
        </Modal>
      )}
    </article>
  );
}

/** Before a new key goes anywhere: who gets it. A server can add names, so these are shown. */
function Recipients({ plan }: { plan: { userId: string; username: string; known: boolean; changed: boolean }[] }) {
  if (!plan.length) return <p data-testid="recipients" className="text-sm text-[var(--text)]">Only you will have the new key.</p>;
  return (
    <div data-testid="recipients" className="text-sm text-[var(--text)]">
      <p className="mb-1 font-medium">The new key goes to you and:</p>
      <ul className="list-disc pl-5">
        {plan.map((p) => (
          <li key={p.userId}>
            {p.username}
            {p.changed && <span className="text-[var(--danger)]"> (their keys have changed, so this will stop until you've checked)</span>}
            {!p.known && <span className="text-[var(--text-muted)]"> (you haven't dealt with them before. Check you expect them here)</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SafetyWords({ member, onClose }: { member: MemberOut; onClose: () => void }) {
  const { vault, toast } = useVault();
  const [words, setWords] = useState<string[]>([]);
  const [verified, setVerified] = useState(false);
  useEffect(() => {
    void vault.identityWordsFor(member.user_id).then(setWords);
    void vault.trustEntries().then((t) => setVerified(!!t[member.user_id]?.verified));
  }, [vault, member.user_id]);
  return (
    <Modal title={`Safety words for ${member.username}`} onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p data-testid="their-words" className="rounded border border-[var(--border)] p-2 text-center font-mono text-sm text-[var(--text)]">{words.join(" ")}</p>
        <p className="text-sm text-[var(--text)]">Ask them to read out the safety words on their Shared vaults page, in person or by phone. If they match, the server can't have swapped their keys.</p>
        {verified ? (
          <Callout>You've already checked these.</Callout>
        ) : (
          <Button
            kind="primary"
            onClick={async () => {
              await vault.markVerified(member.user_id, words);
              toast("Marked as checked");
              onClose();
            }}
          >
            They match
          </Button>
        )}
      </div>
    </Modal>
  );
}

// ---- Emergency access ----------------------------------------------------------------

function EmergencyPanel({ people, onChange }: { people: Person[]; onChange: () => Promise<void> }) {
  const { vault, toast } = useVault();
  const [rows, setRows] = useState<EmergencyOut[]>([]);
  const [me, setMe] = useState("");
  const [who, setWho] = useState("");
  const [days, setDays] = useState(7);
  const [error, setError] = useState("");
  const [compare, setCompare] = useState<{ user_id: string; username: string; invite: boolean } | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    try {
      await vault.refreshEmergency().catch(() => undefined);
      setRows(await vault.emergencyList());
      const trust = await vault.trustEntries();
      setChecked(Object.fromEntries(Object.entries(trust).map(([id, e]) => [id, !!e.verified])));
      setError("");
      setMe(vault.userId ?? "");
    } catch (e) {
      setError(errorText(e));
    }
  }, [vault]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setError("");
    try {
      await fn();
      if (done) toast(done);
      await load();
      await onChange();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const granted = rows.filter((r) => r.grantor_id === me);
  const received = rows.filter((r) => r.grantee_id === me);

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-[var(--border)] p-4">
      <h2 className="font-medium text-[var(--text)]">Emergency access</h2>
      <p className="text-sm text-[var(--text-muted)]">Name someone who can ask for your vault if you can't reach it. When they ask, you get a push and an email, and you can refuse.</p>
      <Callout kind="warn">If you don't refuse before the wait runs out, it opens. They can then read everything in your vaults. Pick someone you'd trust with all of it, and a wait long enough that you'd notice. The wait is kept by this server, so whoever runs the server, working with your contact, could skip it.</Callout>
      <ul className="flex flex-col gap-2">
        {granted.map((r) => (
          <li key={r.id} data-testid="em-granted" className="flex flex-wrap items-center gap-2 text-sm text-[var(--text)]">
            <span className="min-w-0 flex-1">
              {r.grantee} · {r.wait_days} day wait · <span data-testid="em-state">{!checked[r.grantee_id] && r.state !== "ended" ? "compare safety words to finish setting this up" : stateText(r, "grantor")}</span>
            </span>
            {!checked[r.grantee_id] && r.state !== "ended" && <Button small kind="primary" onClick={() => setCompare({ user_id: r.grantee_id, username: r.grantee, invite: false })}>Compare safety words</Button>}
            {r.state === "requested" && <Button small kind="primary" onClick={() => act(() => vault.emergencyAct(r.id, "refuse"), "Refused")}>Refuse</Button>}
            <Button small onClick={() => act(() => vault.emergencyEnd(r), "Ended")}>{r.state === "opened" || r.state === "ended" ? "End and change the keys" : "End"}</Button>
          </li>
        ))}
        {received.map((r) => (
          <li key={r.id} data-testid="em-received" className="flex flex-wrap items-center gap-2 text-sm text-[var(--text)]">
            <span className="min-w-0 flex-1">
              {r.grantor} trusts you · {r.wait_days} day wait · <span data-testid="em-state">{stateText(r, "grantee")}</span>
            </span>
            {r.state === "invited" && <Button small kind="primary" onClick={() => act(() => vault.emergencyAct(r.id, "accept"), "Accepted")}>Accept</Button>}
            {(r.state === "ready" || r.state === "refused") && (
              <Button
                small
                onClick={() => {
                  if (confirm(`Ask for ${r.grantor}'s vault? They'll be told straight away.`)) void act(() => vault.emergencyAct(r.id, "request"), "Asked. They've been told.");
                }}
              >
                Ask for access
              </Button>
            )}
            {r.state === "requested" && r.opens_at && new Date(r.opens_at) <= new Date() && <Button small kind="primary" onClick={() => act(() => vault.emergencyOpen(r.id), "Opened")}>Open their vault</Button>}
            <Button small onClick={() => act(() => vault.emergencyEnd(r), "Ended")}>Stop being their contact</Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <Label text="Trusted contact">
          <select className={inputClass} value={who} onChange={(e) => setWho(e.target.value)} data-testid="em-person">
            <option value="">Choose someone</option>
            {people.filter((p) => !granted.some((g) => g.grantee_id === p.id)).map((p) => <option key={p.id} value={p.id}>{p.username}</option>)}
          </select>
        </Label>
        <Label text="Wait, in days">
          <input className={inputClass} type="number" min={1} max={90} value={days} onChange={(e) => setDays(Number(e.target.value))} />
        </Label>
        <Button
          disabled={!who}
          onClick={() => {
            setError("");
            setCompare({ user_id: who, username: people.find((p) => p.id === who)?.username ?? "them", invite: true });
          }}
        >
          Add
        </Button>
      </div>
      {error && <Callout kind="danger">{error}</Callout>}
      {compare && (
        <EmergencyWords
          person={compare}
          onCancel={() => setCompare(null)}
          onMatch={async (shown) => {
            const { user_id, invite } = compare;
            setCompare(null);
            await act(async () => {
              await vault.markVerified(user_id, shown);
              if (invite) await vault.emergencyInvite(user_id, days);
            }, invite ? "Asked them" : "Checked");
            if (invite) setWho("");
          }}
        />
      )}
    </section>
  );
}

/** Your vault keys go to these keys, and the server's the one saying they're this person's. These
 *  words are how you find out. Nothing's sealed until you've said they match. */
function EmergencyWords({ person, onMatch, onCancel }: { person: { user_id: string; username: string }; onMatch: (shown: string[]) => void; onCancel: () => void }) {
  const { vault } = useVault();
  const [words, setWords] = useState<string[]>([]);
  const [problem, setProblem] = useState("");
  useEffect(() => {
    vault.identityWordsFor(person.user_id).then(setWords).catch((e) => setProblem(errorText(e)));
  }, [vault, person.user_id]);
  return (
    <Modal title={`Is this really ${person.username}?`} onClose={onCancel}>
      <div className="flex flex-col gap-3 text-sm text-[var(--text)]">
        <p>An emergency contact can end up with every key to your vaults, so make sure of who this is. Ask {person.username} to read out the safety words on their Shared vaults page, in person or by phone.</p>
        {problem ? <Callout kind="danger">{problem}</Callout> : <p data-testid="em-words" className="rounded border border-[var(--border)] p-2 text-center font-mono">{words.join(" ")}</p>}
        <p className="text-[var(--text-muted)]">If they don't match, don't go on: someone may be pretending to be them, possibly whoever runs the server.</p>
        <div className="flex flex-wrap gap-2">
          <Button onClick={onCancel}>Not now</Button>
          <Button kind="primary" disabled={!words.length} onClick={() => onMatch(words)}>They match</Button>
        </div>
      </div>
    </Modal>
  );
}

function stateText(r: EmergencyOut, side: "grantor" | "grantee"): string {
  switch (r.state) {
    case "invited":
      return side === "grantor" ? "waiting for them to accept" : "they've asked you";
    case "accepted":
      return side === "grantor" ? "finishing on this device" : "waiting for them to finish setting it up";
    case "ready":
      return "set up";
    case "requested":
      return r.opens_at ? `asked. Opens ${new Date(r.opens_at).toLocaleString()} unless refused` : "asked";
    case "refused":
      return "refused";
    case "opened":
      return side === "grantor" ? "they can read your vault" : "open";
    case "ended":
      return side === "grantor" ? "they've stopped, but they saw your vault. Change the keys" : "ended";
    default:
      return r.state;
  }
}

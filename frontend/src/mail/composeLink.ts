// /mail?compose=1#to=…&subject=…&body=…&from=<mailbox id> opens a new draft, like a
// mailto: link. Passwords uses it for an account deletion request. It only fills in
// the composer: nothing is sent until the person presses Send. The fields ride after
// the #, which the browser doesn't send to the server, so they stay out of its logs.

export type ComposeLink = { to: string; subject: string; body: string; from: string | null };

const MAX_TO = 1000;
const MAX_SUBJECT = 300;
const MAX_BODY = 20_000;
const MAILBOX_ID = /^[0-9a-f-]{36}$/;
const ADDRESS = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function readComposeLink(search: string, hash: string): ComposeLink | null {
  if (new URLSearchParams(search).get("compose") !== "1") return null;
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const to = (p.get("to") ?? "").slice(0, MAX_TO);
  // Addresses only: anything else in the To box is someone's mistake, or a trick.
  const addresses = to.split(/[,;]\s*/).map((a) => a.trim()).filter(Boolean);
  if (addresses.some((a) => !ADDRESS.test(a))) return null;
  const from = p.get("from");
  return {
    to: addresses.join(", "),
    subject: (p.get("subject") ?? "").replace(/[\r\n]+/g, " ").slice(0, MAX_SUBJECT),
    body: (p.get("body") ?? "").slice(0, MAX_BODY),
    from: from && MAILBOX_ID.test(from) ? from : null,
  };
}

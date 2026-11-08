// Which alias a reply comes from, and what to say about sending as it. No imports,
// so it's tested in Node with the vault's own tests (passwords/core/aliases.test.ts).

export interface ThreadAlias {
  id: string;
  address: string;
  domain: string;
  item_id: string | null;
  enabled: boolean;
  count: number;
  last_at: string | null;
  flagged_at: string | null;
  flagged_sender: string;
  send_as: "unknown" | "ok" | "rewritten" | "refused";
  send_as_text: string;
}
export interface ThreadAliases {
  /** Message id -> alias id. */
  messages: Record<string, string>;
  aliases: Record<string, ThreadAlias>;
}

/** The alias a reply should come from: the one the newest email to an alias went to. */
export function replyAlias(info: ThreadAliases | undefined, messageIds: string[]): ThreadAlias | null {
  if (!info) return null;
  for (const id of [...messageIds].reverse()) {
    const alias = info.aliases[info.messages[id]];
    if (alias) return alias;
  }
  return null;
}

export function sendAsNote(sendAs: ThreadAlias["send_as"], text: string): string {
  if (sendAs === "ok") return "";
  if (sendAs === "rewritten") return `Your provider may put your mailbox's own address on this instead. ${text}`;
  if (sendAs === "unknown") return "Not checked yet whether your provider will send as this alias. If it won't, the email will fail or show your mailbox's address.";
  return text;
}

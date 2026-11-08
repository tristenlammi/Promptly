import { Fragment } from "react";
import { Link } from "react-router-dom";

import type { PorchUser } from "@/api/porch";

const URL_RE = /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g;
const AT_RE = /(@[\p{L}\p{N}._-]+)/gu;

/** Words with @mentions of the people it mentions linked to their profiles. */
function Mentions({ text, people }: { text: string; people: Map<string, PorchUser> }) {
  if (!people.size) return <>{text}</>;
  const parts = text.split(AT_RE);
  return (
    <>
      {parts.map((part, i) => {
        const u = i % 2 === 1 ? people.get(part.slice(1).toLowerCase()) : undefined;
        return u ? (
          <Link key={i} to={`/porch/u/${u.id}`} className="font-medium text-[var(--accent-text)] hover:underline">
            {part}
          </Link>
        ) : (
          <Fragment key={i}>{part}</Fragment>
        );
      })}
    </>
  );
}

/** Plain text with web links made clickable, and @mentions of ``mentions``
 *  linked to their profiles (nothing else is interpreted). */
export function RichText({ text, mentions = [] }: { text: string; mentions?: PorchUser[] }) {
  const parts = text.split(URL_RE);
  const people = new Map(mentions.map((u) => [u.username.toLowerCase(), u]));
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <a key={i} href={part} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent-text)] underline-offset-2 hover:underline">
            {part}
          </a>
        ) : (
          <Mentions key={i} text={part} people={people} />
        ),
      )}
    </>
  );
}

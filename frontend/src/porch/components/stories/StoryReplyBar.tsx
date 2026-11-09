import { Loader2, Send } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";

import { porchApi, REACTIONS, type PorchStory } from "@/api/porch";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";
import { cn } from "@/utils/cn";

/**
 * Under someone's story: "Send a message" and the six quick reactions. Both
 * go to your 1:1 conversation with them in Rooms, with the story attached
 * (it shows there while it's live). Nothing is posted on Porch.
 */
export function StoryReplyBar({ story, onBusy }: { story: PorchStory; onBusy?: (busy: boolean) => void }) {
  const navigate = useNavigate();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const name = story.author?.name ?? "them";

  const send = async (body: { text?: string; emoji?: string }) => {
    setBusy(body.emoji ?? "text");
    onBusy?.(true);
    try {
      const got = await porchApi.replyStory(story.id, body);
      if (body.text) setText("");
      toast.success(body.emoji ? `Sent ${body.emoji} to ${name}.` : `Sent to ${name} in Rooms.`, {
        action: { label: "Open", onClick: () => navigate(got.url) },
      });
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't send that. Try again."));
    } finally {
      setBusy(null);
      onBusy?.(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) void send({ text: text.trim() });
        }}
      >
        <label className="min-w-0 flex-1">
          <span className="sr-only">Send {name} a message</span>
          <input
            value={text}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Send ${name} a message`}
            enterKeyHint="send"
            className="h-11 w-full rounded-full border border-white/40 bg-black/30 px-4 text-sm text-white placeholder:text-white/70 focus:border-white focus:outline-none"
          />
        </label>
        <button
          type="submit"
          disabled={!text.trim() || !!busy}
          aria-label="Send"
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--item-accent)] text-white disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white"
        >
          {busy === "text" ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <Send className="h-4 w-4" aria-hidden />}
        </button>
      </form>
      <div role="group" aria-label={`React to ${name}'s story`} className="flex items-center justify-around">
        {REACTIONS.map((e) => (
          <button
            key={e}
            type="button"
            disabled={!!busy}
            onClick={() => void send({ emoji: e })}
            aria-label={`Send ${e}`}
            className={cn(
              "flex h-11 w-11 items-center justify-center rounded-full text-2xl transition hover:scale-110 hover:bg-white/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white disabled:opacity-50",
              busy === e && "scale-125",
            )}
          >
            {e}
          </button>
        ))}
      </div>
    </div>
  );
}

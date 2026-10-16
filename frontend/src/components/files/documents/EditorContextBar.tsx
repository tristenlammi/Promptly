import { useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowLeftToLine,
  ArrowRightToLine,
  ArrowUpToLine,
  Captions,
  Columns2,
  Combine,
  PanelTop,
  PanelLeft,
  Split,
  Trash2,
  Ungroup,
  X,
} from "lucide-react";

import { cn } from "@/utils/cn";

import { CALLOUT_VARIANTS, type CalloutVariant } from "./CalloutExtension";
import { PromptPopover } from "./PromptPopover";
import { useEditorFormatState } from "./useEditorFormatState";
import { useIsPhone } from "./useKeyboardInset";

/**
 * The block-specific controls (WP-4.5, R-226): a strip under the toolbar
 * that appears when the cursor is in a table, a callout, a column layout,
 * or on an image. Tables get rows / columns / merge / header / delete;
 * callouts get their colour and "remove"; columns get add / remove /
 * unwrap; images get alignment and a caption. Each button is an
 * ``editor.chain()`` command — undoable, and synced like any edit.
 */
const VARIANT_DOT: Record<CalloutVariant, string> = {
  info: "bg-sky-500",
  warning: "bg-amber-500",
  success: "bg-emerald-500",
  danger: "bg-rose-500",
};
const VARIANT_NAME: Record<CalloutVariant, string> = {
  info: "Blue",
  warning: "Amber",
  success: "Green",
  danger: "Red",
};

function Btn({
  label,
  onClick,
  disabled,
  active,
  danger,
  children,
}: {
  label: string;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        "inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-xs transition disabled:cursor-not-allowed disabled:opacity-40",
        active ? "bg-black/10 text-[var(--text)] dark:bg-white/15" : "text-[var(--muted)] hover:bg-black/5 hover:text-[var(--text)] dark:hover:bg-white/10",
        danger && "hover:text-[var(--danger)]"
      )}
    >
      {children}
    </button>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div role="group" aria-label={title} className="flex items-center gap-0.5">
      <span className="mr-1 text-[11px] font-medium uppercase tracking-wide text-[var(--text-muted)]">{title}</span>
      {children}
    </div>
  );
}

const Sep = () => <span aria-hidden className="mx-1.5 h-5 w-px bg-[var(--border)]" />;

export function EditorContextBar({ editor }: { editor: Editor | null }) {
  const [captionAt, setCaptionAt] = useState<DOMRect | null>(null);
  useEditorFormatState(editor);
  // Phones can't drag blocks — they get move up / down here (R-231).
  const isPhone = useIsPhone();
  if (!editor || !editor.isEditable) return null;
  const inTable = editor.isActive("table");
  const inCallout = editor.isActive("callout");
  const inColumns = editor.isActive("columns");
  const onImage = editor.isActive("image");
  if (!inTable && !inCallout && !inColumns && !onImage && !isPhone) return null;
  const chain = () => editor.chain().focus();
  const image = onImage ? editor.getAttributes("image") : null;

  return (
    <div
      role="toolbar"
      aria-label="Block options"
      className="flex flex-wrap items-center gap-y-1 border-b border-[var(--border)] bg-[var(--surface)] px-3 py-1"
    >
      {onImage && (
        <Group title="Image">
          <Btn label="Align left" active={image?.align === "left"} onClick={() => chain().setImageAlign("left").run()}>
            <AlignLeft className="h-3.5 w-3.5" />
          </Btn>
          <Btn
            label="Centre"
            active={!image?.align || image?.align === "center"}
            onClick={() => chain().setImageAlign("center").run()}
          >
            <AlignCenter className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Align right" active={image?.align === "right"} onClick={() => chain().setImageAlign("right").run()}>
            <AlignRight className="h-3.5 w-3.5" />
          </Btn>
          <Btn label={image?.caption ? "Edit caption" : "Add caption"} onClick={(e) => setCaptionAt(e.currentTarget.getBoundingClientRect())}>
            <Captions className="h-3.5 w-3.5" />
            {image?.caption ? "Caption" : "Add caption"}
          </Btn>
          <Btn label="Delete image" danger onClick={() => chain().deleteSelection().run()}>
            <Trash2 className="h-3.5 w-3.5" />
          </Btn>
        </Group>
      )}
      {onImage && (inTable || inCallout || inColumns) && <Sep />}
      {inTable && (
        <Group title="Table">
          <Btn label="Insert row above" onClick={() => chain().addRowBefore().run()}>
            <ArrowUpToLine className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Insert row below" onClick={() => chain().addRowAfter().run()}>
            <ArrowDownToLine className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Insert column left" onClick={() => chain().addColumnBefore().run()}>
            <ArrowLeftToLine className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Insert column right" onClick={() => chain().addColumnAfter().run()}>
            <ArrowRightToLine className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Delete row" danger onClick={() => chain().deleteRow().run()}>
            Row <X className="h-3 w-3" />
          </Btn>
          <Btn label="Delete column" danger onClick={() => chain().deleteColumn().run()}>
            Column <X className="h-3 w-3" />
          </Btn>
          <Btn label="Merge cells" disabled={!editor.can().mergeCells()} onClick={() => chain().mergeCells().run()}>
            <Combine className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Split cell" disabled={!editor.can().splitCell()} onClick={() => chain().splitCell().run()}>
            <Split className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Header row" onClick={() => chain().toggleHeaderRow().run()}>
            <PanelTop className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Header column" onClick={() => chain().toggleHeaderColumn().run()}>
            <PanelLeft className="h-3.5 w-3.5" />
          </Btn>
          <Btn label="Delete table" danger onClick={() => chain().deleteTable().run()}>
            <Trash2 className="h-3.5 w-3.5" />
          </Btn>
        </Group>
      )}
      {inTable && (inCallout || inColumns) && <Sep />}
      {inCallout && (
        <Group title="Callout">
          {CALLOUT_VARIANTS.map((v) => (
            <Btn
              key={v}
              label={`${VARIANT_NAME[v]} callout`}
              active={editor.isActive("callout", { variant: v })}
              onClick={() => chain().setCalloutVariant(v).run()}
            >
              <span className={cn("h-3 w-3 rounded-full ring-1 ring-inset ring-black/10", VARIANT_DOT[v])} />
            </Btn>
          ))}
          <Btn label="Remove callout" onClick={() => chain().unsetCallout().run()}>
            <Ungroup className="h-3.5 w-3.5" />
          </Btn>
        </Group>
      )}
      {inCallout && inColumns && <Sep />}
      {inColumns && (
        <Group title="Columns">
          <Btn label="Add column" disabled={!editor.can().addColumn()} onClick={() => chain().addColumn().run()}>
            <Columns2 className="h-3.5 w-3.5" /> Add
          </Btn>
          <Btn label="Remove column" onClick={() => chain().removeColumn().run()}>
            Remove
          </Btn>
          <Btn label="Remove columns" onClick={() => chain().unsetColumns().run()}>
            <Ungroup className="h-3.5 w-3.5" />
          </Btn>
        </Group>
      )}
      {isPhone && (
        <>
          {(onImage || inTable || inCallout || inColumns) && <Sep />}
          <Group title="Block">
            <Btn label="Move block up" disabled={!editor.can().moveBlockUp()} onClick={() => chain().moveBlockUp().run()}>
              <ArrowUp className="h-3.5 w-3.5" />
            </Btn>
            <Btn label="Move block down" disabled={!editor.can().moveBlockDown()} onClick={() => chain().moveBlockDown().run()}>
              <ArrowDown className="h-3.5 w-3.5" />
            </Btn>
          </Group>
        </>
      )}
      {captionAt && (
        <PromptPopover
          anchor={captionAt}
          label="Image caption"
          placeholder="Write a caption…"
          initial={(image?.caption as string | null) ?? ""}
          onSubmit={(v) => editor.chain().focus().setImageCaption(v).run()}
          onClose={() => setCaptionAt(null)}
        />
      )}
    </div>
  );
}

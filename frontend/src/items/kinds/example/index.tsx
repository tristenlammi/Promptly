import { BarChart3, ListChecks, Plus } from "lucide-react";
import { useState } from "react";

import type { ItemModule, ItemViewProps } from "@/items/types";
import {
  Card,
  EmptyState,
  Field,
  ItemButton,
  List,
  ListRow,
  Page,
  ProgressRing,
  Section,
  Sheet,
  TextInput,
  fmtDay,
  nowISO,
  todayISO,
  uid,
} from "@/items/ui";
import { Bars } from "@/items/ui/charts";

/*
 * Example item (hidden in the Store): tally counters. The reference for
 * item authors — tabs, the handle (``item.update`` / ``item.runAction``),
 * the UI kit, a sheet for adding, and the AI hand-off (``ask``).
 */

interface Tap {
  at: string;
  by: number;
}
interface Counter {
  id: string;
  name: string;
  goal: number | null;
  taps: Tap[];
}
interface Data {
  counters: Counter[];
}

const total = (c: Counter, day: string) => c.taps.filter((t) => t.at.slice(0, 10) === day).reduce((n, t) => n + t.by, 0);

function Today({ item, ask }: ItemViewProps<Data>) {
  const day = todayISO();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const counters = item.data.counters;
  return (
    <Page>
      <Section
        title={fmtDay(day, { long: true })}
        action={
          item.canEdit && (
            <ItemButton size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Counter
            </ItemButton>
          )
        }
      >
        {counters.length === 0 ? (
          <EmptyState
            icon={ListChecks}
            title="No counters yet"
            text="Add one, or ask the assistant to set some up."
            action={<ItemButton onClick={() => ask("Set up three useful daily counters for me")}>Ask the assistant</ItemButton>}
          />
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            {counters.map((c) => {
              const n = total(c, day);
              return (
                <Card key={c.id} className="flex items-center gap-4">
                  <ProgressRing value={c.goal ? n / c.goal : 0} size={60}>
                    {n}
                  </ProgressRing>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold text-[var(--text)]">{c.name}</p>
                    <p className="text-xs text-[var(--text-muted)]">{c.goal ? `Goal ${c.goal} a day` : "No goal"}</p>
                  </div>
                  {item.canEdit && (
                    <ItemButton
                      variant="primary"
                      aria-label={`Add one to ${c.name}`}
                      onClick={() => {
                        const at = nowISO();
                        item.update((d) => {
                          d.counters.find((x) => x.id === c.id)?.taps.push({ at, by: 1 });
                        });
                      }}
                    >
                      +1
                    </ItemButton>
                  )}
                </Card>
              );
            })}
          </div>
        )}
      </Section>
      <Sheet
        open={adding}
        onClose={() => setAdding(false)}
        title="New counter"
        footer={
          <ItemButton
            variant="primary"
            block
            disabled={!name.trim()}
            onClick={() => {
              // Ids and times are made *outside* the mutator: it's replayed
              // if the file changed meanwhile, and must give the same result.
              const id = uid("c");
              const label = name.trim();
              item.update((d) => {
                d.counters.push({ id, name: label, goal: null, taps: [] });
              });
              setName("");
              setAdding(false);
            }}
          >
            Add
          </ItemButton>
        }
      >
        <Field label="Name">
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Glasses of water" />
        </Field>
      </Sheet>
    </Page>
  );
}

function History({ item }: ItemViewProps<Data>) {
  const days = Array.from({ length: 14 }, (_, i) => {
    const d = new Date();
    d.setDate(d.getDate() - (13 - i));
    return todayISO(d);
  });
  return (
    <Page>
      {item.data.counters.map((c) => (
        <Section key={c.id} title={c.name}>
          <Card>
            <Bars data={days.map((d) => ({ x: d.slice(5), y: total(c, d) }))} />
          </Card>
        </Section>
      ))}
      <List>
        {item.data.counters.map((c) => (
          <ListRow key={c.id} title={c.name} trailing={`${c.taps.length} taps`} />
        ))}
      </List>
    </Page>
  );
}

const module: ItemModule<Data> = {
  kind: "example",
  tabs: [
    { id: "today", label: "Today", icon: ListChecks, View: Today },
    { id: "history", label: "History", icon: BarChart3, View: History },
  ],
};

export default module;

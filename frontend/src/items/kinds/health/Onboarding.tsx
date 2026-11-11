import { HeartPulse } from "lucide-react";
import { useState } from "react";

import type { ItemViewProps } from "@/items/types";
import { Card, Field, ItemButton, Page, Segmented, Select, TextInput, Toggle } from "@/items/ui";

import { NumberInput, blankReading, insertReading, round } from "./common";
import { LB_PER_KG } from "./metrics";
import type { HealthData, Settings, Sex } from "./types";
import { nowISO, todayISO } from "./zone";

/** First run: units, the basics for BMI/BMR, a starting weight and goal. */
export function Onboarding({ item, ask }: ItemViewProps<HealthData>) {
  const s0 = item.data.settings;
  const [units, setUnits] = useState<"metric" | "us">(s0.weight_unit === "lb" ? "us" : "metric");
  const [height, setHeight] = useState<number | null>(null);
  const [feet, setFeet] = useState<number | null>(null);
  const [inches, setInches] = useState<number | null>(null);
  const [birth, setBirth] = useState("");
  const [sex, setSex] = useState<Sex>("unspecified");
  const [weight, setWeight] = useState<number | null>(null);
  const [goal, setGoal] = useState<number | null>(null);
  const [cycle, setCycle] = useState(false);
  const us = units === "us";

  const finish = (skip = false) => {
    item.update((d) => {
      const patch: Partial<Settings> = us
        ? { weight_unit: "lb", length_unit: "in", glucose_unit: "mgdl", temp_unit: "f", water_unit: "oz" }
        : { weight_unit: "kg", length_unit: "cm", glucose_unit: "mmol", temp_unit: "c", water_unit: "ml" };
      if (us && d.settings.water_unit !== "oz") {
        const w = d.goals.find((g) => g.metric === "water");
        if (w && w.target === 2000) w.target = round(64 * 29.5735, 1);
      }
      Object.assign(d.settings, patch, { onboarded: true, cycle_tracking: cycle });
      if (skip) return;
      const cm = us ? (feet !== null || inches !== null ? ((feet ?? 0) * 12 + (inches ?? 0)) * 2.54 : null) : height;
      if (cm && cm >= 40 && cm <= 260) d.profile.height_cm = round(cm, 1);
      if (birth) d.profile.birth_date = birth;
      d.profile.sex = sex;
      const kg = weight !== null ? (us ? weight / LB_PER_KG : weight) : null;
      if (kg && kg >= 2 && kg <= 400) insertReading(d, { ...blankReading("weight", nowISO()), value: round(kg, 3) });
      const gk = goal !== null ? (us ? goal / LB_PER_KG : goal) : null;
      if (gk && gk >= 2 && gk <= 400) {
        d.goals = d.goals.filter((g) => g.metric !== "weight");
        d.goals.push({
          metric: "weight",
          target: round(gk, 3),
          low: null,
          high: null,
          direction: kg && gk > kg ? "up" : "down",
          target_date: null,
          start_value: kg ? round(kg, 3) : null,
          start_day: todayISO(),
        });
      }
    });
  };

  return (
    <Page>
      <div className="flex flex-col items-center gap-2 pt-4 text-center">
        <span className="flex h-14 w-14 items-center justify-center rounded-2xl bg-[var(--item-accent-fill)] text-white">
          <HeartPulse className="h-7 w-7" />
        </span>
        <h1 className="text-xl font-semibold text-[var(--text)]">Body & Health</h1>
        <p className="max-w-sm text-sm text-[var(--text-muted)]">
          A few basics so your numbers make sense. Everything stays in this file, and you can change it any time in Records → Profile.
        </p>
      </div>
      <Card className="flex flex-col gap-4">
        <Field label="Units">
          <Segmented
            value={units}
            onChange={setUnits}
            options={[
              { value: "metric", label: "kg · cm · mmol/L" },
              { value: "us", label: "lb · in · mg/dL" },
            ]}
          />
        </Field>
        {us ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Height (ft)">
              <NumberInput value={feet} onChange={setFeet} ariaLabel="Height feet" placeholder="5" />
            </Field>
            <Field label="(in)">
              <NumberInput value={inches} onChange={setInches} ariaLabel="Height inches" placeholder="9" />
            </Field>
          </div>
        ) : (
          <Field label="Height (cm)">
            <NumberInput value={height} onChange={setHeight} ariaLabel="Height" placeholder="175" />
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="Date of birth">
            <TextInput type="date" value={birth} max={todayISO()} onChange={(e) => setBirth(e.target.value)} />
          </Field>
          <Field label="Sex" hint="For BMR & reference ranges">
            <Select value={sex} onChange={(e) => setSex(e.target.value as Sex)}>
              <option value="unspecified">Prefer not to say</option>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="intersex">Intersex</option>
            </Select>
          </Field>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Field label={`Weight today (${us ? "lb" : "kg"})`}>
            <NumberInput value={weight} onChange={setWeight} ariaLabel="Weight today" />
          </Field>
          <Field label={`Goal weight (optional)`}>
            <NumberInput value={goal} onChange={setGoal} ariaLabel="Goal weight" />
          </Field>
        </div>
        <div className="flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] px-3 py-2.5">
          <div>
            <p className="text-sm text-[var(--text)]">Track my cycle</p>
            <p className="text-xs text-[var(--text-muted)]">Period log and predictions — off unless you want it</p>
          </div>
          <Toggle checked={cycle} onChange={setCycle} label="Track my cycle" />
        </div>
        <ItemButton variant="primary" size="lg" block onClick={() => finish()}>
          Start
        </ItemButton>
        <div className="flex justify-between">
          <ItemButton variant="ghost" size="sm" onClick={() => finish(true)}>
            Skip for now
          </ItemButton>
          <ItemButton
            variant="ghost"
            size="sm"
            onClick={() => {
              finish(true);
              ask("Help me set up Body & Health: my height, weight, goal, medicines and what I want to track.");
            }}
          >
            Set up with the assistant
          </ItemButton>
        </div>
      </Card>
      <p className="px-2 text-center text-xs text-[var(--text-muted)]">
        Body & Health keeps records and explains numbers against standard references. It isn't medical advice — for anything urgent, call your local emergency number.
      </p>
    </Page>
  );
}

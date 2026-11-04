import { useEffect, useState } from "react";
import { HeartPulse, Loader2 } from "lucide-react";

import { apiClient } from "@/api/client";
import { Button } from "@/components/shared/Button";
import { toast } from "@/store/toastStore";
import { apiErrorMessage } from "@/utils/apiError";

/** The body details Body & Health, Macros and Workout share. */
interface Body {
  sex: "female" | "male" | "intersex" | null;
  birth_date: string | null;
  birth_year: number | null;
  height_cm: number | null;
  weight_unit: "kg" | "lb" | null;
  length_unit: "cm" | "in" | null;
}

const IN_PER_CM = 1 / 2.54;

/** Account → About you → Body: set your sex, date of birth, height and
 *  units once — Body & Health, Macros and Workout all use them (change them
 *  in any of those apps and this follows). Private to you. */
export function BodyProfilePanel() {
  const [body, setBody] = useState<Body | null>(null);
  const [form, setForm] = useState({ sex: "", birth: "", height: "", weight_unit: "kg", length_unit: "cm" });
  const [busy, setBusy] = useState(false);

  const fill = (b: Body) => {
    setBody(b);
    const inches = b.length_unit === "in";
    setForm({
      sex: b.sex ?? "",
      birth: b.birth_date ?? (b.birth_year ? String(b.birth_year) : ""),
      height: b.height_cm == null ? "" : inches ? String(Math.round(b.height_cm * IN_PER_CM)) : String(Math.round(b.height_cm)),
      weight_unit: b.weight_unit ?? "kg",
      length_unit: b.length_unit ?? "cm",
    });
  };

  useEffect(() => {
    apiClient
      .get<Body>("/items/body")
      .then(({ data }) => fill(data))
      .catch(() => setBody(null));
  }, []);

  const save = async () => {
    const payload: Record<string, unknown> = { weight_unit: form.weight_unit, length_unit: form.length_unit };
    if (form.sex) payload.sex = form.sex;
    if (/^\d{4}-\d{2}-\d{2}$/.test(form.birth)) payload.birth_date = form.birth;
    else if (/^\d{4}$/.test(form.birth)) payload.birth_year = Number(form.birth);
    const h = Number(form.height);
    if (form.height && h > 0) payload.height_cm = Math.round((form.length_unit === "in" ? h * 2.54 : h) * 10) / 10;
    setBusy(true);
    try {
      const { data } = await apiClient.put<Body>("/items/body", payload);
      fill(data);
      toast.success("Saved — Body & Health, Macros and Workout use these.");
    } catch (err) {
      toast.error(apiErrorMessage(err, "Couldn't save that."));
    } finally {
      setBusy(false);
    }
  };

  const field = "w-full rounded-input border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)]";
  const label = "block text-xs font-semibold text-[var(--text)]";

  return (
    <section className="mt-4 overflow-hidden rounded-card border border-[var(--border)] bg-[var(--surface)]">
      <header className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-3">
        <HeartPulse className="h-4 w-4 text-[var(--text-muted)]" />
        <h3 className="text-sm font-semibold">Body</h3>
      </header>
      <div className="space-y-4 px-4 py-4">
        <p className="text-xs leading-relaxed text-[var(--text-muted)]">
          Set these once — Body &amp; Health, Macros and Workout all use them, and a weigh-in logged in any of them
          shows in the others. Change them in any of those apps and this updates too. Only you can see them.
        </p>
        {body === null ? (
          <Loader2 className="h-4 w-4 animate-spin text-[var(--text-muted)]" />
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-1.5">
                <label htmlFor="bp-sex" className={label}>Sex</label>
                <select id="bp-sex" className={field} value={form.sex} onChange={(e) => setForm({ ...form, sex: e.target.value })}>
                  <option value="">Not set</option>
                  <option value="female">Female</option>
                  <option value="male">Male</option>
                  <option value="intersex">Intersex</option>
                </select>
              </div>
              <div className="space-y-1.5">
                <label htmlFor="bp-birth" className={label}>Date of birth</label>
                <input
                  id="bp-birth"
                  className={field}
                  placeholder="YYYY-MM-DD (or just the year)"
                  value={form.birth}
                  onChange={(e) => setForm({ ...form, birth: e.target.value.trim() })}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="bp-height" className={label}>Height ({form.length_unit})</label>
                <input
                  id="bp-height"
                  className={field}
                  inputMode="decimal"
                  value={form.height}
                  onChange={(e) => setForm({ ...form, height: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <span className={label}>Units</span>
                <div className="flex gap-2">
                  <select
                    aria-label="Weight unit"
                    className={field}
                    value={form.weight_unit}
                    onChange={(e) => setForm({ ...form, weight_unit: e.target.value })}
                  >
                    <option value="kg">kg</option>
                    <option value="lb">lb</option>
                  </select>
                  <select
                    aria-label="Length unit"
                    className={field}
                    value={form.length_unit}
                    onChange={(e) => {
                      // Keep the height the same length in the new unit.
                      const h = Number(form.height);
                      const next = e.target.value;
                      const converted =
                        form.height && h > 0 && next !== form.length_unit
                          ? String(Math.round(next === "in" ? h * IN_PER_CM : h * 2.54))
                          : form.height;
                      setForm({ ...form, length_unit: next, height: converted });
                    }}
                  >
                    <option value="cm">cm</option>
                    <option value="in">in</option>
                  </select>
                </div>
              </div>
            </div>
            <Button variant="primary" size="sm" onClick={() => void save()} loading={busy}>
              Save
            </Button>
          </>
        )}
      </div>
    </section>
  );
}

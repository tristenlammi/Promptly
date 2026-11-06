// Strength meter. Local only: the password never leaves the device. The dictionaries
// are large, so they load the first time someone needs a score.
export type Strength = { score: 0 | 1 | 2 | 3 | 4; label: string; crackTime: string; warning?: string };

const LABELS = ["Very weak", "Weak", "Fair", "Good", "Strong"];

let ready: Promise<(pw: string, inputs?: string[]) => Strength> | null = null;

function load() {
  ready ??= (async () => {
    const [{ ZxcvbnFactory }, common, en] = await Promise.all([
      import("@zxcvbn-ts/core"),
      import("@zxcvbn-ts/language-common"),
      import("@zxcvbn-ts/language-en"),
    ]);
    const zxcvbn = new ZxcvbnFactory({
      dictionary: { ...common.dictionary, ...en.dictionary },
      graphs: common.adjacencyGraphs,
      translations: en.translations,
    });
    return (pw: string, inputs?: string[]): Strength => {
      const r = zxcvbn.check(pw.slice(0, 256), inputs);
      return {
        score: r.score as Strength["score"],
        label: LABELS[r.score],
        crackTime: String(r.crackTimes.offlineSlowHashingXPerSecond.display ?? ""),
        warning: r.feedback.warning ?? undefined,
      };
    };
  })();
  return ready;
}

export async function strengthOf(pw: string, inputs?: string[]): Promise<Strength> {
  return (await load())(pw, inputs);
}

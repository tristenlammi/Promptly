import type { Opt, PublicByKind, Step, WStep } from "@/api/study";
import { markdownToSpeech } from "@/utils/speechText";

/*
 * What is said when a step is read aloud: the step as a person would read
 * it out, never the answer key. Pure, so it is tested without any audio.
 */

const say = (md: string | undefined | null) => markdownToSpeech(md ?? "").trim();

const list = (label: string, options: Opt[]) => options.map((o, i) => `${label} ${i + 1}: ${say(o.text)}.`).join(" ");

/** The words for a step that is waiting to be answered. */
export function speechFor(step: Pick<Step, "kind" | "public">): string {
  const parts: string[] = [];
  switch (step.kind) {
    case "explain": {
      const p = step.public as PublicByKind["explain"];
      parts.push(p.title, say(p.body_md));
      if (p.key_points.length) parts.push("To take away: " + p.key_points.map(say).join(". ") + ".");
      break;
    }
    case "predict": {
      const p = step.public as PublicByKind["predict"];
      parts.push(say(p.setup_md), say(p.question_md), list("Option", p.options));
      break;
    }
    case "mcq": {
      const p = step.public as PublicByKind["mcq"];
      parts.push(say(p.question_md), list("Option", p.options));
      break;
    }
    case "order_steps": {
      const p = step.public as PublicByKind["order_steps"];
      parts.push(say(p.prompt_md), "In no particular order: " + p.items.map((i) => say(i.text)).join(". ") + ".");
      break;
    }
    case "match_pairs": {
      const p = step.public as PublicByKind["match_pairs"];
      parts.push(say(p.prompt_md), "On one side: " + p.left.map((i) => say(i.text)).join(", ") + ".", "On the other: " + p.right.map((i) => say(i.text)).join(", ") + ".");
      break;
    }
    case "spot_error": {
      const p = step.public as PublicByKind["spot_error"];
      parts.push(say(p.intro_md), list("Line", p.lines));
      break;
    }
    case "worked_example": {
      const p = step.public as PublicByKind["worked_example"];
      parts.push(say(p.problem_md));
      p.steps.forEach((s: WStep, i) => {
        parts.push(s.blank ? `Step ${i + 1}, for you: ${say(s.text_md)} ${list("Option", s.options)}` : `Step ${i + 1}: ${say(s.text_md)}`);
      });
      break;
    }
    case "explain_back":
      parts.push(say((step.public as PublicByKind["explain_back"]).prompt_md));
      break;
    case "scenario": {
      const p = step.public as PublicByKind["scenario"];
      parts.push(say(p.scenario_md), say(p.question_md));
      break;
    }
    case "teach_student": {
      const p = step.public as PublicByKind["teach_student"];
      parts.push(`${p.student_name} says: ${say(p.opening_md)}`);
      break;
    }
    case "capstone":
      parts.push(say((step.public as PublicByKind["capstone"]).task_md));
      break;
    case "explore": {
      const p = step.public as PublicByKind["explore"];
      parts.push(say(p.prompt_md), p.figure.title ? `The figure: ${p.figure.title}.` : "");
      break;
    }
    case "write_code":
      // The task, not the code: code read aloud helps nobody.
      parts.push(say((step.public as PublicByKind["write_code"]).prompt_md));
      break;
  }
  return parts.filter(Boolean).join("\n\n");
}

/** The words for the feedback once a step is answered. */
export function feedbackSpeech(step: Pick<Step, "grade">): string {
  const g = step.grade;
  if (!g) return "";
  const head = g.outcome === "correct" ? "That's right." : g.outcome === "partial" ? "Nearly." : "Not quite.";
  return [head, say(g.feedback_md)].filter(Boolean).join(" ");
}

/** Put dictated words onto the end of what is already written. */
export function appendDictation(text: string, spoken: string, max: number): string {
  const add = spoken.trim();
  if (!add) return text;
  const joined = text.trim() ? `${text.replace(/\s+$/, "")} ${add}` : add;
  return joined.slice(0, max);
}

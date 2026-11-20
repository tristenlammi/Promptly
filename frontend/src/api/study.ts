import { isAxiosError } from "axios";

import { apiClient } from "./client";

/**
 * Study (``/api/study``): an AI teacher. A subject is a map of concepts;
 * lessons are a run of steps of ten kinds; every answer changes the
 * teacher's picture of the learner. Nothing streams: plain JSON calls,
 * some of which wait on the model (3–25 s).
 *
 * Mirrors ``docs/study-api.md`` / ``backend/app/study/router.py``.
 */

export type Depth = "overview" | "solid" | "deep";
export type Level = "child" | "teen" | "adult";
export type SubjectStatus = "building" | "failed" | "placement" | "active" | "complete";
export type BuildStage = "queued" | "sources" | "plan" | "saving" | "done" | "failed";

export interface Progress {
  total: number;
  done: number;
  learning: number;
  percent: number;
}

export interface Build {
  stage: BuildStage;
  progress: number;
  error: string | null;
}

export interface Subject {
  id: string;
  title: string;
  goal: string;
  prior: string;
  depth: Depth;
  level: Level;
  status: SubjectStatus;
  summary: string;
  use_web: boolean;
  archived: boolean;
  build: Build;
  progress: Progress;
  next_concept: { id: string; title: string } | null;
  /** The applied task that comes next (a finished unit's, or the final one). */
  next_capstone: { scope: "unit" | "final"; unit_id: string | null; title: string } | null;
  /** Learned ideas whose review is due now. */
  due_count: number;
  capstone: Capstone | null;
  created_at: string;
  updated_at: string;
  last_studied_at: string | null;
}

/** Where a unit's (or the subject's) applied task is up to. */
export interface Capstone {
  status: "passed" | "open" | "closed";
  tries: number;
  outcome: "correct" | "partial" | "wrong";
  met: number;
  points: number;
  at: string;
}

/** Days studied: honest counts, nothing to protect. */
export interface StudyStats {
  today: boolean;
  week: number;
  streak: number;
  total: number;
}

export interface StudyHome {
  subjects: Subject[];
  due_total: number;
  stats: StudyStats;
}

export type ConceptState = "new" | "learning" | "mastered" | "known";

export interface Concept {
  id: string;
  unit_id: string;
  position: number;
  title: string;
  summary: string;
  objectives: string[];
  nature: "fact" | "process" | "principle" | "skill";
  prereqs: string[];
  mastery: number;
  state: ConceptState;
  locked: boolean;
  origin: "planned" | "gap";
  reason: string;
  gap_for: string | null;
  steps_done: number;
  sources: number[];
  last_seen_at: string | null;
  mastered_at: string | null;
  /** When it next comes back for review (learned ideas only). */
  due_at: string | null;
  due: boolean;
  reviews: number;
  lapses: number;
}

export interface Unit {
  id: string;
  position: number;
  title: string;
  summary: string;
  capstone: Capstone | null;
  concepts: Concept[];
}

export interface Source {
  n: number;
  kind: "web" | "file" | "note";
  title: string;
  url: string | null;
  file_id: string | null;
  note_id: string | null;
}

export interface Misconception {
  id: string;
  concept_id: string;
  label: string;
  detail: string;
  resolved: boolean;
  last_seen_at: string;
}

export interface LessonSummary {
  steps: number;
  graded: number;
  correct: number;
  mastered: string[];
  gaps_added: string[];
  parked: string[];
  next: string | null;
  subject_complete: boolean;
  capstones?: { scope: "unit" | "final"; title: string; outcome: "correct" | "partial" | "wrong" }[];
}

export interface ReviewSummary {
  reviewed: number;
  remembered: number;
  slipped: number;
  reopened: string[];
  left: number;
}

export interface PlacementSummary {
  asked: number;
  right: number;
  known: number;
  likely: number;
  total: number;
}

export interface Session {
  id: string;
  subject_id: string;
  kind: "placement" | "lesson" | "review";
  status: "active" | "done";
  started_at: string;
  ended_at: string | null;
  target_steps: number;
  focus_concept_id: string | null;
  summary: LessonSummary | PlacementSummary | ReviewSummary | null;
  steps?: Step[];
}

export interface SubjectFull extends Subject {
  units: Unit[];
  sources: Source[];
  misconceptions: Misconception[];
  active_session: Session | null;
}

export type StepKind =
  | "explain"
  | "predict"
  | "mcq"
  | "order_steps"
  | "match_pairs"
  | "spot_error"
  | "worked_example"
  | "explain_back"
  | "scenario"
  | "teach_student"
  | "capstone";

export interface Opt {
  id: string;
  text: string;
}

export type WStep =
  | { id: string; blank: false; text_md: string }
  | { id: string; blank: true; text_md: string; options: Opt[] };

export interface DiagramNode {
  id: string;
  label: string;
  note: string;
  parent?: string | null;
}

export type Diagram =
  | { type: "flow" | "cycle"; title: string; nodes: DiagramNode[]; edges: { from: string; to: string; label: string }[] }
  | { type: "tree"; title: string; nodes: (DiagramNode & { parent: string | null })[] }
  | { type: "timeline"; title: string; items: { label: string; when: string; note: string }[] }
  | { type: "compare"; title: string; columns: string[]; rows: { label: string; cells: string[] }[] }
  | { type: "bars"; title: string; unit: string; bars: { label: string; value: number }[] };

export type ExplainAngle = "plain" | "analogy" | "example" | "step_by_step" | "contrast";

/** What each kind shows before it is answered. */
export interface PublicByKind {
  explain: { title: string; body_md: string; key_points: string[]; diagram: Diagram | null; angle: ExplainAngle; sources: number[] };
  predict: { setup_md: string; question_md: string; options: Opt[]; sources: number[] };
  mcq: { question_md: string; options: Opt[]; sources: number[] };
  order_steps: { prompt_md: string; items: Opt[]; sources: number[] };
  match_pairs: { prompt_md: string; left: Opt[]; right: Opt[]; sources: number[] };
  spot_error: { intro_md: string; lines: Opt[]; sources: number[] };
  worked_example: { problem_md: string; steps: WStep[]; sources: number[] };
  explain_back: { prompt_md: string; sources: number[] };
  scenario: { scenario_md: string; question_md: string; sources: number[] };
  teach_student: { student_name: string; opening_md: string; max_turns: number; sources: number[] };
  capstone: { task_md: string; scope: "unit" | "final"; title: string; concepts: { id: string; title: string }[]; sources: number[] };
}

/** The answer key, once answered. */
export interface RevealByKind {
  explain: Record<string, never>;
  predict: { correct_id: string; notes: Record<string, string>; misconceptions: Record<string, string>; explain_md: string };
  mcq: RevealByKind["predict"];
  order_steps: { order: string[]; explain_md: string };
  match_pairs: { pairs: Record<string, string>; explain_md: string };
  spot_error: { error_id: string; explain_md: string; correction: string; misconception: string };
  worked_example: { blanks: Record<string, string>; notes: Record<string, string> };
  explain_back: { rubric: string[]; model_answer_md: string };
  scenario: RevealByKind["explain_back"];
  teach_student: { misconception: string; rubric: string[]; model_answer_md: string };
  /** ``rubric_concepts[i]`` is the id of the idea rubric point ``i`` shows. */
  capstone: { rubric: string[]; rubric_concepts: string[]; model_answer_md: string };
}

export interface Grade {
  outcome: "correct" | "partial" | "wrong";
  feedback_md?: string;
  misconception?: string | null;
  detail?: Record<string, unknown>;
  gap_concept_id?: string | null;
}

export interface Turn {
  role: "learner" | "student";
  text: string;
  resolved?: boolean;
}

export interface Ask {
  role: "learner" | "teacher";
  text: string;
  mode?: string;
}

export interface Step<K extends StepKind = StepKind> {
  id: string;
  session_id: string;
  concept_id: string;
  position: number;
  kind: K;
  role: "" | "recall" | "test_out" | "placement" | "review" | "capstone";
  status: "pending" | "answered" | "skipped";
  graded: boolean;
  public: PublicByKind[K];
  hints_shown: string[];
  hints_left: number;
  confidence: 1 | 2 | 3 | null;
  answer: Record<string, unknown> | null;
  turns: Turn[];
  turns_left?: number;
  asks: Ask[];
  grade: Grade | null;
  reveal: RevealByKind[K] | null;
  created_at: string;
  answered_at: string | null;
}

export type Change =
  | { type: "mastery"; concept_id: string; before: number; after: number }
  | { type: "mastered"; concept_id: string; title: string; by: "lesson" | "test_out" }
  | { type: "relearn"; concept_id: string; title: string }
  | { type: "gap_added"; concept_id: string; title: string; reason: string; for_concept_id: string }
  /** A review answer: the rating it earned (1 again … 4 easy) and when it comes back. */
  | { type: "review"; concept_id: string; rating: 1 | 2 | 3 | 4; next_days: number | null }
  | { type: "capstone"; scope: "unit" | "final"; unit_id: string | null; title: string; outcome: "correct" | "partial" | "wrong"; status: "passed" | "open" | "closed"; reopened: string[] }
  | { type: "subject_complete" };

export interface NextReply {
  done: boolean;
  step: Step | null;
  concept: Concept | null;
  session: Session;
  subject_status: SubjectStatus;
  /** The subject the step belongs to (a review can span subjects). */
  subject?: { id: string; title: string };
}

export interface ReportRow {
  id: string;
  title: string;
  summary: string;
  mastery: number;
  state: ConceptState;
  mastered_at: string | null;
  steps: number;
}

export interface Report {
  subject: Subject;
  finished: boolean;
  totals: { concepts: number; known_before: number; steps: number; lessons: number };
  units: { id: string; title: string; capstone: Capstone | null; solid: ReportRow[] }[];
  shaky: (ReportRow & { why: string })[];
  added: (ReportRow & { reason: string; for: string | null })[];
  capstone: Capstone | null;
  sources: { n: number; kind: "web" | "file" | "note"; title: string; url: string | null }[];
  next: { title: string; why: string }[];
}

export interface Remind {
  on: boolean;
  /** "HH:MM", in the person's own time zone. */
  time: string;
}

export interface AnswerReply {
  step: Step;
  changes: Change[];
  concept: Concept;
  progress: Progress;
  subject_status: SubjectStatus;
}

export type AskMode = "question" | "simpler" | "analogy" | "example" | "deeper";

export interface Prefs {
  level: Level;
  /** An admin has fixed the level for this account. */
  level_locked: boolean;
  levels: Level[];
  depths: Depth[];
  remind: Remind;
}

export interface VoiceSupport {
  /** Steps can be read aloud. */
  listen: boolean;
  /** Written answers can be dictated. */
  speak: boolean;
}

export interface NewSubject {
  title: string;
  goal?: string;
  prior?: string;
  depth?: Depth;
  level?: Level;
  use_web?: boolean;
  file_ids?: string[];
  note_ids?: string[];
}

export const studyApi = {
  async prefs(): Promise<Prefs> {
    return (await apiClient.get<Prefs>("/study/prefs")).data;
  },
  async setPrefs(level: Level): Promise<Prefs> {
    return (await apiClient.put<Prefs>("/study/prefs", { level })).data;
  },
  async setRemind(remind: Remind): Promise<Prefs> {
    return (await apiClient.put<Prefs>("/study/prefs", { remind })).data;
  },
  async voice(): Promise<VoiceSupport> {
    return (await apiClient.get<VoiceSupport>("/study/voice")).data;
  },
  async subjects(): Promise<Subject[]> {
    return (await apiClient.get<{ subjects: Subject[] }>("/study/subjects")).data.subjects;
  },
  async home(): Promise<StudyHome> {
    return (await apiClient.get<StudyHome>("/study/subjects")).data;
  },
  /** A review sitting over what is due: one subject's, or everything's. */
  async startReview(subjectId?: string): Promise<Session> {
    return (await apiClient.post<{ session: Session }>("/study/reviews", subjectId ? { subject_id: subjectId } : {})).data.session;
  },
  async report(id: string): Promise<Report> {
    return (await apiClient.get<Report>(`/study/subjects/${id}/report`)).data;
  },
  async suggestNext(id: string): Promise<{ title: string; why: string }[]> {
    return (await apiClient.post<{ next: { title: string; why: string }[] }>(`/study/subjects/${id}/report/suggest`)).data.next;
  },
  async create(body: NewSubject): Promise<Subject> {
    return (await apiClient.post<Subject>("/study/subjects", body)).data;
  },
  async build(id: string): Promise<{ status: SubjectStatus } & Build> {
    return (await apiClient.get<{ status: SubjectStatus } & Build>(`/study/subjects/${id}/build`)).data;
  },
  async retry(id: string): Promise<Subject> {
    return (await apiClient.post<Subject>(`/study/subjects/${id}/retry`)).data;
  },
  async subject(id: string): Promise<SubjectFull> {
    return (await apiClient.get<SubjectFull>(`/study/subjects/${id}`)).data;
  },
  async patch(id: string, body: { title?: string; archived?: boolean; level?: Level }): Promise<SubjectFull> {
    return (await apiClient.patch<SubjectFull>(`/study/subjects/${id}`, body)).data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/study/subjects/${id}`);
  },
  async startPlacement(id: string): Promise<{ session: Session; step: Step | null }> {
    return (await apiClient.post<{ session: Session; step: Step | null }>(`/study/subjects/${id}/placement`)).data;
  },
  async skipPlacement(id: string): Promise<SubjectFull> {
    return (await apiClient.post<SubjectFull>(`/study/subjects/${id}/placement/skip`)).data;
  },
  async startSession(id: string, body: { concept_id?: string; test_out?: boolean } = {}): Promise<Session> {
    return (await apiClient.post<{ session: Session }>(`/study/subjects/${id}/sessions`, body)).data.session;
  },
  async next(sessionId: string): Promise<NextReply> {
    return (await apiClient.post<NextReply>(`/study/sessions/${sessionId}/next`)).data;
  },
  async session(sessionId: string): Promise<Session> {
    return (await apiClient.get<{ session: Session }>(`/study/sessions/${sessionId}`)).data.session;
  },
  async end(sessionId: string): Promise<Session> {
    return (await apiClient.post<{ session: Session }>(`/study/sessions/${sessionId}/end`)).data.session;
  },
  async answer(stepId: string, answer: Record<string, unknown>, confidence?: 1 | 2 | 3 | null): Promise<AnswerReply> {
    const body: Record<string, unknown> = { answer };
    if (confidence) body.confidence = confidence;
    return (await apiClient.post<AnswerReply>(`/study/steps/${stepId}/answer`, body)).data;
  },
  async hint(stepId: string): Promise<{ hint: string; hints_left: number }> {
    return (await apiClient.post<{ hint: string; hints_left: number }>(`/study/steps/${stepId}/hint`)).data;
  },
  async turn(stepId: string, text: string): Promise<Step> {
    return (await apiClient.post<{ step: Step }>(`/study/steps/${stepId}/turn`, { text })).data.step;
  },
  async ask(stepId: string, mode: AskMode, question?: string): Promise<{ answer_md: string; asks: Ask[] }> {
    const body: Record<string, unknown> = { mode };
    if (question) body.question = question;
    return (await apiClient.post<{ answer_md: string; asks: Ask[] }>(`/study/steps/${stepId}/ask`, body)).data;
  },
};

/** Study's own error: ``{detail: {code, message}}``. Anything else gets a plain sentence. */
export function studyError(err: unknown): { code: string; message: string; status: number } {
  if (isAxiosError(err)) {
    const status = err.response?.status ?? 0;
    const detail = (err.response?.data as { detail?: unknown } | undefined)?.detail;
    // The shared send limit (chat's "sending messages too quickly"), in Study's words.
    if (status === 429 && (typeof detail !== "string" || /too quickly/i.test(detail)) && !(detail && typeof detail === "object"))
      return { code: "rate", message: "You're going faster than the teacher can keep up. Give it a minute, then carry on: nothing is lost.", status };
    if (detail && typeof detail === "object" && !Array.isArray(detail)) {
      const d = detail as { code?: unknown; message?: unknown };
      if (typeof d.message === "string") return { code: typeof d.code === "string" ? d.code : "error", message: d.message, status };
    }
    if (typeof detail === "string") return { code: "error", message: detail, status };
    if (status === 0) return { code: "offline", message: "Can't reach Promptly. Check your connection and try again.", status };
    if (status === 422) return { code: "bad", message: "That couldn't be sent. Try again.", status };
  }
  return { code: "error", message: "Something went wrong. Try again.", status: 0 };
}

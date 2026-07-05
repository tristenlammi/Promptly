import { apiClient } from "./client";
import type {
  CalibrationHistory,
  ConfidenceCaptureResponse,
  LearnerProfileResponse,
  LearnerProfileUpdate,
  MisconceptionEntry,
  MisconceptionListResponse,
  NotesState,
  ObjectiveMasteryListResponse,
  QuickReviewRequest,
  QuickReviewResponse,
  ReviewQueueResponse,
  SessionArc,
  StartExamResponse,
  StudyBoardBlock,
  AssessorStatus,
  SessionTimelineEntry,
  StudyExamSummary,
  StudyProjectDetail,
  StudyProjectSummary,
  StudySendMessageResponse,
  StudySessionDetail,
  StudyMaterial,
  StudyUnitSummary,
  UnitEnterResponse,
  WhiteboardExerciseDetail,
  WhiteboardExerciseSummary,
  WhiteboardSubmitResponse,
} from "./types";

export interface CreateStudyProjectPayload {
  title: string;
  topics?: string[];
  goal?: string | null;
  learning_request: string;
  /** Optional self-reported starting level. Controls how aggressively
   *  the planner front-loads foundation units and the default register
   *  the unit tutor pitches at. */
  current_level?: "beginner" | "some_exposure" | "refresher" | null;
  /** Deprecated — the backend now reads the teaching model from
   *  admin app_settings. These fields are accepted for back-compat
   *  but ignored when a study model is configured. */
  model_id?: string;
  provider_id?: string;
  /** Optional list of already-uploaded file IDs to attach as course
   *  material. Extracted text grounds the unit plan; full RAG indexing
   *  happens asynchronously after the project is created. */
  material_file_ids?: string[];
}

export interface UpdateStudyProjectPayload {
  title?: string;
  topics?: string[];
  goal?: string | null;
  model_id?: string | null;
}

export interface RegeneratePlanPayload {
  model_id?: string | null;
  provider_id?: string | null;
}

export interface StartExamPayload {
  model_id?: string | null;
  provider_id?: string | null;
  time_limit_seconds?: number | null;
}

export interface StudySendMessagePayload {
  content: string;
  provider_id?: string | null;
  model_id?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
  /** Deep-link hint: mastery-row id the student clicked from the
   *  ReviewQueueWidget. Backend stamps it on the session on the
   *  FIRST message only (sticky-until-satisfied) and then clears it
   *  when the tutor scores the matching objective. Safe to send on
   *  every message — the server ignores it once the session already
   *  has a focus. */
  review_focus_objective_id?: string | null;
}

export interface ListProjectsParams {
  status?: "planning" | "active" | "completed" | "archived";
  include_archived?: boolean;
}

/** Live plan-generation state (L0.3) — the wizard's progress poll. */
export interface PlanningProgress {
  status: "planning" | "active" | "completed" | "archived";
  /** reading | drafting | building — null once the run is terminal. */
  stage: string | null;
  /** Unit titles seen so far while the plan streams. */
  units_drafted: number;
  error: string | null;
}

// ---------------------------------------------------------------------
// Team Learning (L1) — workspace courses + enrollments.
// ---------------------------------------------------------------------
export type CourseStatus = "draft" | "published" | "archived";

export interface CourseUnitPayload {
  title: string;
  description?: string | null;
  learning_objectives: string[];
  source_file_ids: string[];
}

export interface CourseUnit extends CourseUnitPayload {
  id: string;
  order_index: number;
}

export interface CourseSummary {
  id: string;
  workspace_id: string;
  title: string;
  brief: string;
  difficulty_preset: string | null;
  status: CourseStatus;
  unit_count: number;
  enrollment_count: number;
  drafting_error: string | null;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CourseDetail extends CourseSummary {
  source_file_ids: string[];
  unit_mastery_floor: number;
  exam_pass_score: number;
  units: CourseUnit[];
}

export interface CourseDraftProgress {
  status: CourseStatus;
  drafting: boolean;
  stage: string | null;
  units_drafted: number;
  unit_count: number;
  error: string | null;
}

export interface CourseEnrollment {
  id: string;
  course_id: string;
  learner_user_id: string;
  learner_name: string | null;
  assigned_by: string | null;
  project_id: string;
  due_at: string | null;
  status: string;
  created_at: string;
}

/** One learner-row in the lead's progress dashboard (L2). Measured state
 *  only — the API never exposes transcripts. */
export interface CourseProgressRow {
  enrollment_id: string;
  learner_user_id: string;
  learner_name: string | null;
  status: string; // assigned | in_progress | completed | overdue
  due_at: string | null;
  last_active_at: string | null;
  completed_units: number;
  total_units: number;
  overall_mastery: number | null;
  units: {
    order_index: number;
    title: string;
    status: string;
    mastery_score: number | null;
  }[];
  latest_exam_score: number | null;
  latest_exam_passed: boolean | null;
  exam_attempts: number;
  open_struggle_flags: number;
}

/** Workspace-wide competency rollup (L3): who on the team knows what. */
export interface CompetencyMatrix {
  courses: { id: string; title: string; status: string }[];
  members: {
    user_id: string;
    username: string | null;
    cells: {
      course_id: string;
      status: string;
      overall_mastery: number | null;
      exam_score: number | null;
      exam_passed: boolean | null;
    }[];
  }[];
}

/** A question the course materials couldn't answer (L2 gap inbox). */
export interface MaterialGap {
  id: string;
  course_id: string;
  unit_title: string | null;
  question: string;
  status: "open" | "resolved";
  created_at: string;
  resolved_at: string | null;
}

export const courseApi = {
  async create(payload: {
    workspace_id: string;
    title: string;
    brief: string;
    difficulty_preset?: string | null;
    source_file_ids?: string[];
    draft_with_ai?: boolean;
  }): Promise<CourseDetail> {
    const { data } = await apiClient.post<CourseDetail>(
      "/study/courses",
      payload
    );
    return data;
  },
  async list(workspaceId: string): Promise<CourseSummary[]> {
    const { data } = await apiClient.get<CourseSummary[]>("/study/courses", {
      params: { workspace_id: workspaceId },
    });
    return data;
  },
  async get(id: string): Promise<CourseDetail> {
    const { data } = await apiClient.get<CourseDetail>(`/study/courses/${id}`);
    return data;
  },
  async draftProgress(id: string): Promise<CourseDraftProgress> {
    const { data } = await apiClient.get<CourseDraftProgress>(
      `/study/courses/${id}/draft-progress`
    );
    return data;
  },
  async redraft(id: string): Promise<CourseDraftProgress> {
    const { data } = await apiClient.post<CourseDraftProgress>(
      `/study/courses/${id}/redraft`
    );
    return data;
  },
  async update(
    id: string,
    payload: Partial<{
      title: string;
      brief: string;
      difficulty_preset: string | null;
      source_file_ids: string[];
      unit_mastery_floor: number;
      exam_pass_score: number;
    }>
  ): Promise<CourseDetail> {
    const { data } = await apiClient.patch<CourseDetail>(
      `/study/courses/${id}`,
      payload
    );
    return data;
  },
  async replaceUnits(
    id: string,
    units: CourseUnitPayload[]
  ): Promise<CourseDetail> {
    const { data } = await apiClient.put<CourseDetail>(
      `/study/courses/${id}/units`,
      units
    );
    return data;
  },
  async publish(id: string): Promise<CourseDetail> {
    const { data } = await apiClient.post<CourseDetail>(
      `/study/courses/${id}/publish`
    );
    return data;
  },
  async archive(id: string): Promise<CourseDetail> {
    const { data } = await apiClient.post<CourseDetail>(
      `/study/courses/${id}/archive`
    );
    return data;
  },
  async remove(id: string): Promise<void> {
    await apiClient.delete(`/study/courses/${id}`);
  },
  async enroll(
    id: string,
    payload: { user_id: string; due_at?: string | null }
  ): Promise<CourseEnrollment> {
    const { data } = await apiClient.post<CourseEnrollment>(
      `/study/courses/${id}/enroll`,
      payload
    );
    return data;
  },
  async enrollments(id: string): Promise<CourseEnrollment[]> {
    const { data } = await apiClient.get<CourseEnrollment[]>(
      `/study/courses/${id}/enrollments`
    );
    return data;
  },
  /** Lead dashboard (L2): per-learner mastery/activity/exam rollups. */
  async progress(id: string): Promise<CourseProgressRow[]> {
    const { data } = await apiClient.get<CourseProgressRow[]>(
      `/study/courses/${id}/progress`
    );
    return data;
  },
  /** Gap inbox (L2): questions the materials couldn't answer. */
  async gaps(id: string, includeResolved = false): Promise<MaterialGap[]> {
    const { data } = await apiClient.get<MaterialGap[]>(
      `/study/courses/${id}/gaps`,
      { params: includeResolved ? { include_resolved: true } : undefined }
    );
    return data;
  },
  async resolveGap(courseId: string, gapId: string): Promise<MaterialGap> {
    const { data } = await apiClient.post<MaterialGap>(
      `/study/courses/${courseId}/gaps/${gapId}/resolve`
    );
    return data;
  },
  /** Competency matrix (L3): members × courses rollup for the workspace. */
  async competency(workspaceId: string): Promise<CompetencyMatrix> {
    const { data } = await apiClient.get<CompetencyMatrix>(
      `/study/workspaces/${workspaceId}/competency`
    );
    return data;
  },
};

export const studyApi = {
  async listProjects(
    params: ListProjectsParams = {}
  ): Promise<StudyProjectSummary[]> {
    const { data } = await apiClient.get<StudyProjectSummary[]>(
      "/study/projects",
      { params }
    );
    return data;
  },
  async getProject(id: string): Promise<StudyProjectDetail> {
    const { data } = await apiClient.get<StudyProjectDetail>(
      `/study/projects/${id}`
    );
    return data;
  },
  async createProject(
    payload: CreateStudyProjectPayload
  ): Promise<StudyProjectDetail> {
    // Returns fast with status="planning" (L0.3); plan generation runs in
    // the background — poll planningProgress() for the real stages.
    const { data } = await apiClient.post<StudyProjectDetail>(
      "/study/projects",
      payload
    );
    return data;
  },
  /** Live state of the initial plan generation (L0.3) — polled by the
   *  create wizard so its progress screen shows real stages. */
  async planningProgress(id: string): Promise<PlanningProgress> {
    const { data } = await apiClient.get<PlanningProgress>(
      `/study/projects/${id}/planning-progress`
    );
    return data;
  },
  async updateProject(
    id: string,
    payload: UpdateStudyProjectPayload
  ): Promise<StudyProjectSummary> {
    const { data } = await apiClient.patch<StudyProjectSummary>(
      `/study/projects/${id}`,
      payload
    );
    return data;
  },
  async deleteProject(id: string): Promise<void> {
    await apiClient.delete(`/study/projects/${id}`);
  },
  async calibrateProject(id: string): Promise<StudyProjectSummary> {
    const { data } = await apiClient.post<StudyProjectSummary>(
      `/study/projects/${id}/calibrate`
    );
    return data;
  },
  async archiveProject(id: string): Promise<StudyProjectSummary> {
    const { data } = await apiClient.post<StudyProjectSummary>(
      `/study/projects/${id}/archive`
    );
    return data;
  },
  async unarchiveProject(id: string): Promise<StudyProjectSummary> {
    const { data } = await apiClient.post<StudyProjectSummary>(
      `/study/projects/${id}/unarchive`
    );
    return data;
  },
  async regeneratePlan(
    id: string,
    payload: RegeneratePlanPayload = {}
  ): Promise<StudyProjectDetail> {
    const { data } = await apiClient.post<StudyProjectDetail>(
      `/study/projects/${id}/regenerate-plan`,
      payload,
      { timeout: 120_000 }
    );
    return data;
  },

  async enterUnit(unitId: string): Promise<UnitEnterResponse> {
    const { data } = await apiClient.post<UnitEnterResponse>(
      `/study/units/${unitId}/enter`
    );
    return data;
  },
  async getUnit(unitId: string): Promise<StudyUnitSummary> {
    const { data } = await apiClient.get<StudyUnitSummary>(
      `/study/units/${unitId}`
    );
    return data;
  },
  async resetUnit(unitId: string): Promise<StudyUnitSummary> {
    const { data } = await apiClient.post<StudyUnitSummary>(
      `/study/units/${unitId}/reset`
    );
    return data;
  },

  async startFinalExam(
    projectId: string,
    payload: StartExamPayload = {}
  ): Promise<StartExamResponse> {
    const { data } = await apiClient.post<StartExamResponse>(
      `/study/projects/${projectId}/final-exam`,
      payload
    );
    return data;
  },
  async getExam(examId: string): Promise<StudyExamSummary> {
    const { data } = await apiClient.get<StudyExamSummary>(
      `/study/exams/${examId}`
    );
    return data;
  },
  async timeoutExam(examId: string): Promise<StudyExamSummary> {
    const { data } = await apiClient.post<StudyExamSummary>(
      `/study/exams/${examId}/timeout`
    );
    return data;
  },

  async getSession(id: string): Promise<StudySessionDetail> {
    const { data } = await apiClient.get<StudySessionDetail>(
      `/study/sessions/${id}`
    );
    return data;
  },
  async deleteSession(id: string): Promise<void> {
    await apiClient.delete(`/study/sessions/${id}`);
  },

  async sendMessage(
    sessionId: string,
    payload: StudySendMessagePayload
  ): Promise<StudySendMessageResponse> {
    const { data } = await apiClient.post<StudySendMessageResponse>(
      `/study/sessions/${sessionId}/messages`,
      payload
    );
    return data;
  },
  streamUrl(sessionId: string, streamId: string): string {
    return `/api/study/sessions/${sessionId}/stream/${streamId}`;
  },

  async getNotes(sessionId: string): Promise<NotesState> {
    const { data } = await apiClient.get<NotesState>(
      `/study/sessions/${sessionId}/notes`
    );
    return data;
  },
  async updateNotes(
    sessionId: string,
    notes: string | null
  ): Promise<NotesState> {
    const { data } = await apiClient.post<NotesState>(
      `/study/sessions/${sessionId}/notes/update`,
      { notes }
    );
    return data;
  },

  async listExercises(sessionId: string): Promise<WhiteboardExerciseSummary[]> {
    const { data } = await apiClient.get<WhiteboardExerciseSummary[]>(
      `/study/sessions/${sessionId}/exercises`
    );
    return data;
  },
  async getExercise(
    sessionId: string,
    exerciseId: string
  ): Promise<WhiteboardExerciseDetail> {
    const { data } = await apiClient.get<WhiteboardExerciseDetail>(
      `/study/sessions/${sessionId}/exercises/${exerciseId}`
    );
    return data;
  },
  /**
   * Mint a short-lived signed URL the browser can use as an
   * ``<iframe src>`` to render the exercise HTML. The iframe itself
   * can't attach the Bearer token (browsers don't let you set headers
   * on iframe navigations), so the backend issues a URL-embeddable
   * HMAC token while we're still authenticated here. See
   * ``backend/app/study/frame_auth.py`` for the full rationale.
   */
  async createExerciseFrameUrl(exerciseId: string): Promise<string> {
    const { data } = await apiClient.post<{ url: string; token: string }>(
      `/study/exercises/${exerciseId}/frame-token`
    );
    return data.url;
  },
  async submitExercise(
    sessionId: string,
    payload: {
      exercise_id: string;
      answers: unknown;
    }
  ): Promise<WhiteboardSubmitResponse> {
    const { data } = await apiClient.post<WhiteboardSubmitResponse>(
      `/study/sessions/${sessionId}/whiteboard/submit`,
      payload
    );
    return data;
  },

  // ---- Learner state (Study 10/10) --------------------------------
  async getLearnerProfile(projectId: string): Promise<LearnerProfileResponse> {
    const { data } = await apiClient.get<LearnerProfileResponse>(
      `/study/projects/${projectId}/learner-profile`
    );
    return data;
  },
  async updateLearnerProfile(
    projectId: string,
    payload: LearnerProfileUpdate
  ): Promise<LearnerProfileResponse> {
    const { data } = await apiClient.put<LearnerProfileResponse>(
      `/study/projects/${projectId}/learner-profile`,
      payload
    );
    return data;
  },
  async getObjectiveMastery(
    projectId: string
  ): Promise<ObjectiveMasteryListResponse> {
    const { data } = await apiClient.get<ObjectiveMasteryListResponse>(
      `/study/projects/${projectId}/objective-mastery`
    );
    return data;
  },
  async getMisconceptions(
    projectId: string,
    includeResolved = false
  ): Promise<MisconceptionListResponse> {
    const { data } = await apiClient.get<MisconceptionListResponse>(
      `/study/projects/${projectId}/misconceptions`,
      { params: { include_resolved: includeResolved } }
    );
    return data;
  },
  async resolveMisconception(
    projectId: string,
    misconceptionId: string
  ): Promise<MisconceptionEntry> {
    const { data } = await apiClient.post<MisconceptionEntry>(
      `/study/projects/${projectId}/misconceptions/${misconceptionId}/resolve`
    );
    return data;
  },
  async getReviewQueue(projectId: string): Promise<ReviewQueueResponse> {
    const { data } = await apiClient.get<ReviewQueueResponse>(
      `/study/projects/${projectId}/review-queue`
    );
    return data;
  },
  async captureConfidence(
    sessionId: string,
    payload: { level: number; objective_index?: number | null; note?: string | null }
  ): Promise<ConfidenceCaptureResponse> {
    const { data } = await apiClient.post<ConfidenceCaptureResponse>(
      `/study/sessions/${sessionId}/confidence`,
      payload
    );
    return data;
  },

  // ---- Lesson board (Phase 3) ------------------------------------
  async getBoardBlocks(sessionId: string): Promise<StudyBoardBlock[]> {
    const { data } = await apiClient.get<StudyBoardBlock[]>(
      `/study/sessions/${sessionId}/board`
    );
    return data;
  },
  async getSessionArc(sessionId: string): Promise<SessionArc> {
    const { data } = await apiClient.get<SessionArc>(
      `/study/sessions/${sessionId}/arc`
    );
    return data;
  },
  async setSessionGoal(
    sessionId: string,
    goal: string | null
  ): Promise<{ session_goal: string | null }> {
    const { data } = await apiClient.patch<{ session_goal: string | null }>(
      `/study/sessions/${sessionId}/goal`,
      { session_goal: goal }
    );
    return data;
  },
  async getAssessorStatus(): Promise<AssessorStatus> {
    const { data } = await apiClient.get<AssessorStatus>(
      `/study/assessor-status`
    );
    return data;
  },
  async getSessionTimeline(projectId: string): Promise<SessionTimelineEntry[]> {
    const { data } = await apiClient.get<SessionTimelineEntry[]>(
      `/study/projects/${projectId}/session-timeline`
    );
    return data;
  },

  async getCalibrationHistory(projectId: string): Promise<CalibrationHistory> {
    const { data } = await apiClient.get<CalibrationHistory>(
      `/study/projects/${projectId}/calibration-history`
    );
    return data;
  },

  async quickReview(
    projectId: string,
    payload: QuickReviewRequest
  ): Promise<QuickReviewResponse> {
    const { data } = await apiClient.post<QuickReviewResponse>(
      `/study/projects/${projectId}/quick-review`,
      payload
    );
    return data;
  },

  async listMaterials(projectId: string): Promise<StudyMaterial[]> {
    const { data } = await apiClient.get<StudyMaterial[]>(
      `/study/projects/${projectId}/materials`
    );
    return data;
  },

  async attachMaterial(
    projectId: string,
    fileId: string
  ): Promise<StudyMaterial> {
    const { data } = await apiClient.post<StudyMaterial>(
      `/study/projects/${projectId}/materials`,
      { file_id: fileId }
    );
    return data;
  },

  async deleteMaterial(
    projectId: string,
    materialId: string
  ): Promise<void> {
    await apiClient.delete(
      `/study/projects/${projectId}/materials/${materialId}`
    );
  },
};

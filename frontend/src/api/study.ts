import { apiClient } from "./client";
import type {
  ConfidenceCaptureResponse,
  LearnerProfileResponse,
  LearnerProfileUpdate,
  MisconceptionEntry,
  MisconceptionListResponse,
  NotesState,
  ObjectiveMasteryListResponse,
  ReviewQueueResponse,
  StartExamResponse,
  StudyExamSummary,
  StudyProjectDetail,
  StudyProjectSummary,
  StudySendMessageResponse,
  StudySessionDetail,
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
  model_id: string;
  provider_id: string;
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
    const { data } = await apiClient.post<StudyProjectDetail>(
      "/study/projects",
      payload,
      // Plan generation runs inline with the create — allow plenty of
      // time for longer models to settle before the client bails.
      { timeout: 120_000 }
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
};

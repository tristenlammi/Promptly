import { apiClient } from "./client";
import type {
  ExcalidrawSnapshot,
  StudyProjectDetail,
  StudyProjectSummary,
  StudySendMessageResponse,
  StudySessionDetail,
  StudySessionSummary,
  WhiteboardExerciseDetail,
  WhiteboardExerciseSummary,
  WhiteboardState,
  WhiteboardSubmitResponse,
} from "./types";

export interface CreateStudyProjectPayload {
  title: string;
  topics?: string[];
  goal?: string | null;
  model_id?: string | null;
  provider_id?: string | null;
  /** When true (default) the server also creates an initial session. */
  create_session?: boolean;
}

export interface UpdateStudyProjectPayload {
  title?: string;
  topics?: string[];
  goal?: string | null;
  model_id?: string | null;
}

export interface StudySendMessagePayload {
  content: string;
  provider_id?: string | null;
  model_id?: string | null;
  temperature?: number | null;
  max_tokens?: number | null;
}

export const studyApi = {
  async listProjects(): Promise<StudyProjectSummary[]> {
    const { data } = await apiClient.get<StudyProjectSummary[]>("/study/projects");
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
      payload
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

  async createSession(projectId: string): Promise<StudySessionSummary> {
    const { data } = await apiClient.post<StudySessionSummary>(
      `/study/projects/${projectId}/sessions`
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

  async getWhiteboard(sessionId: string): Promise<WhiteboardState> {
    const { data } = await apiClient.get<WhiteboardState>(
      `/study/sessions/${sessionId}/whiteboard`
    );
    return data;
  },
  async updateWhiteboard(
    sessionId: string,
    snapshot: ExcalidrawSnapshot | null
  ): Promise<WhiteboardState> {
    const { data } = await apiClient.post<WhiteboardState>(
      `/study/sessions/${sessionId}/whiteboard/update`,
      { snapshot }
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
  async submitExercise(
    sessionId: string,
    payload: {
      exercise_id: string;
      answers: unknown;
      excalidraw_snapshot_b64?: string | null;
    }
  ): Promise<WhiteboardSubmitResponse> {
    const { data } = await apiClient.post<WhiteboardSubmitResponse>(
      `/study/sessions/${sessionId}/whiteboard/submit`,
      payload
    );
    return data;
  },
};

import { apiClient } from "./client";
import type {
  MfaBackupCodesPayload,
  MfaEmailEnrollPayload,
  MfaEmailSendPayload,
  MfaEnrollmentCompletePayload,
  MfaStatus,
  MfaTotpEnrollPayload,
  MfaTrustedDevice,
} from "./types";

/**
 * Helper for endpoints that take a one-shot bearer token (the
 * ``mfa_challenge`` or ``mfa_enrollment`` JWT) instead of the
 * normal access token. Skips the access-token interceptor by
 * setting the header explicitly — the request interceptor only
 * fills it in when nothing is already present, but to be safe we
 * also pass ``Authorization: ""`` would not work, so instead we
 * simply override the header. The response interceptor's auto-refresh
 * will *not* fire because these endpoints don't expect an access token
 * for refresh to swap in.
 */
function authHeader(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` };
}

export const mfaApi = {
  // -----------------------------------------------------------------
  // Already-authenticated management
  // -----------------------------------------------------------------
  async status(): Promise<MfaStatus> {
    const { data } = await apiClient.get<MfaStatus>("/auth/mfa/status");
    return data;
  },

  async listTrustedDevices(): Promise<MfaTrustedDevice[]> {
    const { data } =
      await apiClient.get<MfaTrustedDevice[]>("/auth/mfa/trusted-devices");
    return data;
  },

  async revokeTrustedDevice(id: string): Promise<void> {
    await apiClient.delete(`/auth/mfa/trusted-devices/${id}`);
  },

  async revokeAllTrustedDevices(): Promise<void> {
    await apiClient.delete("/auth/mfa/trusted-devices");
  },

  async regenerateBackupCodes(): Promise<MfaBackupCodesPayload> {
    const { data } = await apiClient.post<MfaBackupCodesPayload>(
      "/auth/mfa/backup-codes/regenerate"
    );
    return data;
  },

  async disable(password: string, code: string): Promise<void> {
    await apiClient.post("/auth/mfa/disable", { password, code });
  },

  // -----------------------------------------------------------------
  // Self-service enrollment (already authenticated)
  // -----------------------------------------------------------------
  async beginTotp(): Promise<MfaTotpEnrollPayload> {
    const { data } =
      await apiClient.post<MfaTotpEnrollPayload>("/auth/mfa/setup/totp");
    return data;
  },

  async verifyTotp(code: string): Promise<MfaEnrollmentCompletePayload> {
    const { data } = await apiClient.post<MfaEnrollmentCompletePayload>(
      "/auth/mfa/setup/totp/verify",
      { code }
    );
    return data;
  },

  async beginEmail(email_address?: string): Promise<MfaEmailEnrollPayload> {
    const { data } = await apiClient.post<MfaEmailEnrollPayload>(
      "/auth/mfa/setup/email",
      email_address ? { email_address } : {}
    );
    return data;
  },

  async verifyEmail(code: string): Promise<MfaEnrollmentCompletePayload> {
    const { data } = await apiClient.post<MfaEnrollmentCompletePayload>(
      "/auth/mfa/setup/email/verify",
      { code }
    );
    return data;
  },

  // -----------------------------------------------------------------
  // Login challenge — uses challenge_token issued by /auth/login
  // -----------------------------------------------------------------
  async verifyChallenge(
    challengeToken: string,
    body: {
      totp_code?: string;
      email_code?: string;
      backup_code?: string;
      trust_device?: boolean;
    }
  ): Promise<MfaEnrollmentCompletePayload> {
    const { data } = await apiClient.post<MfaEnrollmentCompletePayload>(
      "/auth/mfa/verify",
      body,
      { headers: authHeader(challengeToken) }
    );
    return data;
  },

  async sendEmailOtpForChallenge(
    challengeToken: string
  ): Promise<MfaEmailSendPayload> {
    const { data } = await apiClient.post<MfaEmailSendPayload>(
      "/auth/mfa/email/send",
      null,
      { headers: authHeader(challengeToken) }
    );
    return data;
  },

  // -----------------------------------------------------------------
  // Forced enrollment — uses enrollment_token issued by /auth/login
  // -----------------------------------------------------------------
  async forcedBeginTotp(
    enrollmentToken: string
  ): Promise<MfaTotpEnrollPayload> {
    const { data } = await apiClient.post<MfaTotpEnrollPayload>(
      "/auth/mfa/setup/totp/forced",
      null,
      { headers: authHeader(enrollmentToken) }
    );
    return data;
  },

  async forcedVerifyTotp(
    enrollmentToken: string,
    code: string
  ): Promise<MfaEnrollmentCompletePayload> {
    const { data } = await apiClient.post<MfaEnrollmentCompletePayload>(
      "/auth/mfa/setup/totp/verify/forced",
      { code },
      { headers: authHeader(enrollmentToken) }
    );
    return data;
  },

  async forcedBeginEmail(
    enrollmentToken: string,
    email_address?: string
  ): Promise<MfaEmailEnrollPayload> {
    const { data } = await apiClient.post<MfaEmailEnrollPayload>(
      "/auth/mfa/setup/email/forced",
      email_address ? { email_address } : {},
      { headers: authHeader(enrollmentToken) }
    );
    return data;
  },

  async forcedVerifyEmail(
    enrollmentToken: string,
    code: string
  ): Promise<MfaEnrollmentCompletePayload> {
    const { data } = await apiClient.post<MfaEnrollmentCompletePayload>(
      "/auth/mfa/setup/email/verify/forced",
      { code },
      { headers: authHeader(enrollmentToken) }
    );
    return data;
  },
};

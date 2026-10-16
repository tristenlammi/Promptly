import { useQuery } from "@tanstack/react-query";

import { apiClient } from "@/api/client";

export interface PasswordPolicy {
  min_length: number;
  max_length: number;
  summary: string;
  trusted_device_days: number;
}

/** What the server will accept, so every password screen says the same
 *  thing (R-194). Falls back to the server's defaults while loading. */
const FALLBACK: PasswordPolicy = {
  min_length: 10,
  max_length: 128,
  summary: "At least 10 characters, with a number and a symbol (like ! @ # or -).",
  trusted_device_days: 30,
};

export function usePasswordPolicy(): PasswordPolicy {
  const { data } = useQuery({
    queryKey: ["password-policy"],
    queryFn: async () => (await apiClient.get<PasswordPolicy>("/auth/password-policy")).data,
    staleTime: Infinity,
  });
  return data ?? FALLBACK;
}

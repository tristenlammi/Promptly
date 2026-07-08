import { apiClient } from "./client";

/** Metadata for a link's hover preview (see backend links_router). */
export interface LinkPreview {
  url: string;
  title: string | null;
  description: string | null;
  favicon: string | null;
  image: string | null;
  site_name: string | null;
}

export const linksApi = {
  /** Fetch title / description / favicon for a URL (SSRF-safe, cached). */
  async unfurl(url: string): Promise<LinkPreview> {
    const { data } = await apiClient.get<LinkPreview>("/links/unfurl", {
      params: { url },
    });
    return data;
  },
};

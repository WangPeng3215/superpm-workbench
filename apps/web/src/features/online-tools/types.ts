import type { OnlineToolCategory, OnlineToolIconKey } from "@superpm/shared";

export interface OnlineToolPayload {
  name: string;
  url: string;
  icon: OnlineToolIconKey | null;
  category: OnlineToolCategory;
  description: string;
  enabled: boolean;
  isFavorite: boolean;
}

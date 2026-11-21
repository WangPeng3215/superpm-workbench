import { ref } from "vue";
import type { ProjectOverview } from "@superpm/shared";
import { projectApi } from "../../api/projects";
import { errorMessage } from "../../api/client";

export function useProjectOverview(projectId: () => number) {
  const overview = ref<ProjectOverview | null>(null);
  const loading = ref(false);
  const error = ref("");
  let revision = 0;

  async function load() {
    const token = ++revision;
    loading.value = true;
    error.value = "";
    try {
      const result = await projectApi.overview(projectId());
      if (revision === token) overview.value = result;
    } catch (cause) {
      if (revision === token) error.value = errorMessage(cause);
    } finally {
      if (revision === token) loading.value = false;
    }
  }

  return { overview, loading, error, load };
}

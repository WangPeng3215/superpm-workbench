import { ref } from "vue";
import { projectApi, type ProjectEvent } from "../../api/projects";
import { errorMessage } from "../../api/client";

export function useProjectActivity(projectId: () => number) {
  const items = ref<ProjectEvent[]>([]);
  const loading = ref(false);
  const loadingMore = ref(false);
  const error = ref("");
  const hasMore = ref(false);
  const nextCursor = ref<string | null>(null);
  let revision = 0;

  async function refresh() {
    const token = ++revision;
    loading.value = true;
    loadingMore.value = false;
    error.value = "";
    items.value = [];
    nextCursor.value = null;
    hasMore.value = false;
    try {
      const result = await projectApi.events(projectId());
      if (token !== revision) return;
      items.value = result.items;
      hasMore.value = result.hasMore;
      nextCursor.value = result.nextCursor;
    } catch (cause) {
      if (token === revision) error.value = errorMessage(cause);
    } finally {
      if (token === revision) loading.value = false;
    }
  }

  async function loadMore() {
    const cursor = nextCursor.value;
    if (!hasMore.value || !cursor || loading.value || loadingMore.value) return;
    const token = revision;
    loadingMore.value = true;
    error.value = "";
    try {
      const result = await projectApi.events(projectId(), cursor);
      if (token !== revision) return;
      const seen = new Set(items.value.map((item) => item.id));
      items.value.push(...result.items.filter((item) => !seen.has(item.id)));
      hasMore.value = result.hasMore;
      nextCursor.value = result.nextCursor;
    } catch (cause) {
      if (token === revision) error.value = errorMessage(cause);
    } finally {
      if (token === revision) loadingMore.value = false;
    }
  }

  return {
    items,
    loading,
    loadingMore,
    error,
    hasMore,
    nextCursor,
    refresh,
    loadMore,
  };
}

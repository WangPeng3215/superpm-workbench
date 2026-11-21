/** External reference lookups may acknowledge only the content revision they read. */
export function createContentRevision() {
  let revision = 0;
  return {
    invalidate() {
      revision += 1;
    },
    async resolve(
      source: string,
      resolve: (source: string) => Promise<string>,
      apply: (result: string) => void,
    ) {
      const token = ++revision;
      const result = await resolve(source);
      if (token !== revision) return false;
      apply(result);
      return true;
    },
  };
}

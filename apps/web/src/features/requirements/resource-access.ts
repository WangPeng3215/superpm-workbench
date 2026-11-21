import { ApiError } from "../../api/client";

/** A missing child does not establish that its requirement is inaccessible. */
export async function resolveResourceAccessFailure(
  error: unknown,
  recheckRequirement: () => Promise<unknown>,
): Promise<
  "unrelated" | "resource-missing" | "requirement-lost" | "unverified"
> {
  if (!(error instanceof ApiError)) return "unrelated";
  if (error.status === 403) return "requirement-lost";
  if (error.status !== 404) return "unrelated";
  try {
    await recheckRequirement();
    return "resource-missing";
  } catch (recheckError) {
    return recheckError instanceof ApiError &&
      [403, 404].includes(recheckError.status)
      ? "requirement-lost"
      : "unverified";
  }
}

import { ApiError } from "./api/transport";

// A failed read as the page shows it: what failed, and whether Retry can help.
export interface LoadFailure {
  message: string;
  retryable: boolean;
}

// A response the page could not parse throws a schema validation error whose
// message is a raw JSON dump, so the page names the failure instead of
// printing the dump. Retry is offered only when retrying can work: a network
// failure, a server error, a timeout, or rate limiting. A request the API
// refused, or a resource it doesn't have, fails the same way again.
export function loadFailure(error: unknown): LoadFailure {
  if (error instanceof Error && error.name === "ZodError") {
    return { message: "Rubrist returned a response this page couldn't read.", retryable: false };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof ApiError) {
    return { message, retryable: error.status >= 500 || error.status === 408 || error.status === 429 };
  }
  return { message, retryable: true };
}

// The fallback when a read settles with no skill and no error.
export const NO_SKILL_FAILURE: LoadFailure = {
  message: "Rubrist returned no skill for this criterion.",
  retryable: true
};

import { ApiError } from "./api/transport";

// A failed read as the page shows it: what failed, and whether Retry can help.
export interface LoadFailure {
  message: string;
  retryable: boolean;
}

const UNREADABLE: LoadFailure = {
  message: "Rubrist returned a response this page couldn't read.",
  retryable: false
};

// Retrying can work after a network failure, a server error, a timeout, rate
// limiting, or a sign-in. A 501 is an unconfigured feature, and other 4xx
// responses are refused requests or missing resources: they fail the same way
// again.
export function retryableStatus(status: number): boolean {
  return status === 401 || status === 408 || status === 429 || (status >= 500 && status !== 501);
}

// A response the page could not parse throws a schema validation error whose
// message is a raw JSON dump. Some API helpers rethrow it as an ApiError that
// carries the successful status. Either way the page names the failure instead
// of printing the dump.
export function loadFailure(error: unknown): LoadFailure {
  if (error instanceof Error && error.name === "ZodError") return UNREADABLE;
  // A body that isn't JSON at all, often a proxy's error page, can be
  // transient, so it keeps Retry but not the parser's message.
  if (error instanceof SyntaxError) return { message: UNREADABLE.message, retryable: true };
  if (error instanceof ApiError) {
    if (error.status < 400) return UNREADABLE;
    return { message: error.message, retryable: retryableStatus(error.status) };
  }
  return { message: error instanceof Error ? error.message : String(error), retryable: true };
}

// The fallback when a read settles with no skill and no error.
export const NO_SKILL_FAILURE: LoadFailure = {
  message: "Rubrist returned no skill for this criterion.",
  retryable: true
};

// What a failed read says on the page. A response the page could not parse
// throws a schema validation error whose message is a raw JSON dump, so the
// page names the failure instead of printing the dump.
export function loadErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === "ZodError") {
    return "Rubrist returned a response this page couldn't read.";
  }
  return error instanceof Error ? error.message : String(error);
}

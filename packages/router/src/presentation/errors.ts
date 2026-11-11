import { z } from "zod";

export class UserFacingError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
  }
}

export function formatError(error: unknown): string {
  // A ZodError's message is its issues as a JSON array; the prettified form reads as text.
  const text =
    error instanceof z.ZodError
      ? z.prettifyError(error)
      : error instanceof Error
        ? error.message
        : String(error);
  return text
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

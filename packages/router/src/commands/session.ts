export function formatSession(input: { id: string; phase: string; route?: string }): string {
  return `session ${input.id} phase=${input.phase} route=${input.route ?? "none"}`;
}

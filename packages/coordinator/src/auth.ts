export function requireRole(
  header: string | null,
  env: { writerSecret: string; readerSecret: string },
  role: "writer" | "reader",
): boolean {
  const token = header?.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
  if (role === "writer") {
    return token === env.writerSecret;
  }
  return token === env.readerSecret;
}

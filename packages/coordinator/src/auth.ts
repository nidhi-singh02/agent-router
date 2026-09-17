const encoder = new TextEncoder();

// Compares every byte of the longer value so the time taken does not reveal how much of the
// token matched. Workers lack node:crypto's timingSafeEqual without the nodejs_compat flag.
function constantTimeEqual(left: string, right: string): boolean {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.max(a.length, b.length);
  let difference = a.length ^ b.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return difference === 0;
}

export function requireRole(
  header: string | null,
  env: { writerSecret: string; readerSecret: string },
  role: "writer" | "reader",
): boolean {
  const secret = role === "writer" ? env.writerSecret : env.readerSecret;
  // Fail closed: an unset or empty secret must never match a missing or empty token.
  if (typeof secret !== "string" || secret.length === 0) {
    return false;
  }
  if (!header?.startsWith("Bearer ")) {
    return false;
  }
  const token = header.slice("Bearer ".length);
  if (token.length === 0) {
    return false;
  }
  return constantTimeEqual(token, secret);
}

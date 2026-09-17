import { requireRole } from "./auth.js";
import { D1LeaseRepository, type D1DatabaseLike, type LeaseRepository } from "./leases.js";
export interface CoordinatorEnv {
  writerSecret: string;
  readerSecret: string;
  maxTtlSeconds: number;
  repository: LeaseRepository;
  now: () => number;
}
function decode(value: string): string | undefined {
  try {
    return decodeURIComponent(value);
  } catch {
    return undefined;
  }
}
async function json(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await request.json();
    return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
function leaseInput(
  body: Record<string, unknown>,
  env: CoordinatorEnv,
  accountFingerprint?: string,
  leaseId?: string,
) {
  return {
    accountFingerprint:
      accountFingerprint ??
      (typeof body.accountFingerprint === "string" ? body.accountFingerprint : ""),
    leaseId: leaseId ?? (typeof body.leaseId === "string" ? body.leaseId : ""),
    ttlSeconds: typeof body.ttlSeconds === "number" ? body.ttlSeconds : 0,
    maxTtlSeconds: env.maxTtlSeconds,
    modelFamily: typeof body.modelFamily === "string" ? body.modelFamily : undefined,
    reservedCapacity: typeof body.reservedCapacity === "number" ? body.reservedCapacity : undefined,
    now: env.now(),
  };
}
export async function handleCoordinatorRequest(
  request: Request,
  env: CoordinatorEnv,
): Promise<Response> {
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");
  if (request.method === "POST" && url.pathname === "/leases") {
    if (!requireRole(authorization, env, "writer"))
      return new Response("forbidden", { status: 403 });
    const body = await json(request);
    if (!body) return new Response("malformed lease request", { status: 400 });
    const result = await env.repository.create(leaseInput(body, env));
    return result.ok
      ? new Response(null, { status: 201 })
      : new Response(result.error, { status: 400 });
  }
  const action = url.pathname.match(/^\/leases\/([^/]+)\/([^/]+)\/(renew|release)$/);
  if (request.method === "POST" && action) {
    if (!requireRole(authorization, env, "writer"))
      return new Response("forbidden", { status: 403 });
    const fingerprint = decode(action[1]!);
    const leaseId = decode(action[2]!);
    if (!fingerprint || !leaseId) return new Response("malformed lease request", { status: 400 });
    if (action[3] === "release") {
      await env.repository.release(fingerprint, leaseId);
      return new Response(null, { status: 204 });
    }
    const body = await json(request);
    if (!body) return new Response("malformed lease request", { status: 400 });
    const result = await env.repository.renew(leaseInput(body, env, fingerprint, leaseId));
    return result.ok
      ? new Response(null, { status: 200 })
      : new Response(result.error, { status: 400 });
  }
  const status = url.pathname.match(/^\/accounts\/([^/]+)\/status$/);
  if (request.method === "GET" && status) {
    if (!requireRole(authorization, env, "reader"))
      return new Response("forbidden", { status: 403 });
    const fingerprint = decode(status[1]!);
    if (!fingerprint) return new Response("malformed account fingerprint", { status: 400 });
    return Response.json({ activity: await env.repository.activity(fingerprint, env.now()) });
  }
  return new Response("not found", { status: 404 });
}
export default {
  fetch(
    request: Request,
    env: { WRITER_SECRET?: string; READER_SECRET?: string; LEASES?: D1DatabaseLike },
  ): Promise<Response> {
    if (!env.WRITER_SECRET || !env.READER_SECRET)
      return Promise.resolve(new Response("forbidden", { status: 403 }));
    if (!env.LEASES) return Promise.resolve(new Response("service unavailable", { status: 503 }));
    return handleCoordinatorRequest(request, {
      writerSecret: env.WRITER_SECRET,
      readerSecret: env.READER_SECRET,
      maxTtlSeconds: 30,
      repository: new D1LeaseRepository(env.LEASES),
      now: () => Date.now(),
    });
  },
};

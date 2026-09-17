import { requireRole } from "./auth.js";
import { createLease, expireLeases, normalizedActivity, type LeaseRecord } from "./leases.js";

export interface CoordinatorEnv {
  writerSecret: string;
  readerSecret: string;
  maxTtlSeconds: number;
  store: Map<string, LeaseRecord>;
  now: () => number;
}

export async function handleCoordinatorRequest(
  request: Request,
  env: CoordinatorEnv,
): Promise<Response> {
  expireLeases(env.store, env.now());
  const url = new URL(request.url);
  const authorization = request.headers.get("authorization");

  if (request.method === "POST" && url.pathname === "/leases") {
    if (!requireRole(authorization, env, "writer")) {
      return new Response("forbidden", { status: 403 });
    }
    const body = (await request.json()) as {
      accountFingerprint?: string;
      ttlSeconds?: number;
      modelFamily?: string;
      reservedCapacity?: number;
    };
    const result = createLease(env.store, {
      accountFingerprint: body.accountFingerprint ?? "",
      ttlSeconds: body.ttlSeconds ?? 0,
      maxTtlSeconds: env.maxTtlSeconds,
      modelFamily: body.modelFamily,
      reservedCapacity: body.reservedCapacity,
      now: env.now(),
    });
    if (!result.ok) {
      return new Response(result.error, { status: 400 });
    }
    return new Response(null, { status: 201 });
  }

  const renew = url.pathname.match(/^\/leases\/([^/]+)\/renew$/);
  if (request.method === "POST" && renew) {
    if (!requireRole(authorization, env, "writer")) {
      return new Response("forbidden", { status: 403 });
    }
    const body = (await request.json().catch(() => ({}))) as { ttlSeconds?: number };
    const result = createLease(env.store, {
      accountFingerprint: decodeURIComponent(renew[1] ?? ""),
      ttlSeconds: body.ttlSeconds ?? 0,
      maxTtlSeconds: env.maxTtlSeconds,
      now: env.now(),
    });
    if (!result.ok) {
      return new Response(result.error, { status: 400 });
    }
    return new Response(null, { status: 200 });
  }

  const release = url.pathname.match(/^\/leases\/([^/]+)\/release$/);
  if (request.method === "POST" && release) {
    if (!requireRole(authorization, env, "writer")) {
      return new Response("forbidden", { status: 403 });
    }
    env.store.delete(decodeURIComponent(release[1] ?? ""));
    return new Response(null, { status: 204 });
  }

  const status = url.pathname.match(/^\/accounts\/([^/]+)\/status$/);
  if (request.method === "GET" && status) {
    if (!requireRole(authorization, env, "reader")) {
      return new Response("forbidden", { status: 403 });
    }
    const record = env.store.get(decodeURIComponent(status[1] ?? ""));
    return Response.json({ activity: normalizedActivity(record) });
  }

  return new Response("not found", { status: 404 });
}

export default {
  fetch(
    request: Request,
    env: { WRITER_SECRET: string; READER_SECRET: string; LEASES: unknown },
  ): Promise<Response> {
    return handleCoordinatorRequest(request, {
      writerSecret: env.WRITER_SECRET,
      readerSecret: env.READER_SECRET,
      maxTtlSeconds: 30,
      store: new Map(),
      now: () => Date.now(),
    });
  },
};

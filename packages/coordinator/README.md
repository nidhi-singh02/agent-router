# Heartbeat coordinator

Local development only until Cloudflare deployment is explicitly approved.

```sh
npx wrangler d1 migrations apply model-router-leases --local
npx vitest --run
```

Do not run `wrangler deploy` without confirming the Cloudflare account and environment.
The API never lists raw leases or participant records. Owner reads receive only
`inactive`, `active`, or `constrained`.

Every provider operation has a unique lease ID. Overlapping operations for one account
remain independent, and the Worker persists them through the `LEASES` D1 binding. A
missing binding fails closed with `503`; malformed authenticated requests return `400`.

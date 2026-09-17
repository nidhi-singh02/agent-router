# Heartbeat coordinator

Local development only until Cloudflare deployment is explicitly approved.

```sh
npx wrangler d1 migrations apply model-router-leases --local
npx vitest --run
```

Do not run `wrangler deploy` without confirming the Cloudflare account and environment.
The API never lists raw leases or participant records. Owner reads receive only
`inactive`, `active`, or `constrained`.

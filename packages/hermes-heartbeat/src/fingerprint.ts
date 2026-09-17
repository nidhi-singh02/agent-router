import { createHmac } from "node:crypto";

export function accountFingerprint(accountId: string, secret: string): string {
  return createHmac("sha256", secret).update(`model-router:v1:${accountId}`).digest("hex");
}

export interface BrowserSession {
  available: boolean;
  kind: "none" | "attached";
}

export function attachBrowserSession(explicit = false): BrowserSession {
  if (!explicit) {
    return { available: false, kind: "none" };
  }
  return { available: true, kind: "attached" };
}

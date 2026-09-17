export function isHerdrEnv(env: NodeJS.Dict<string>): boolean {
  return env.HERDR_ENV === "1";
}

export async function waitForReadiness(
  inspect: () => Promise<"ready" | "blocked" | "starting">,
  attempts = 5,
): Promise<"ready" | "blocked"> {
  for (let i = 0; i < attempts; i += 1) {
    const state = await inspect();
    if (state === "ready" || state === "blocked") {
      return state;
    }
  }
  return "blocked";
}

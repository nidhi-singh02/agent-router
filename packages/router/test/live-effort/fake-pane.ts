import type { ReasoningEffort } from "../../src/domain/model-profile.js";
import type {
  CommandResult,
  HerdrAgentInfo,
  HerdrAgentState,
  HerdrPaneClient,
} from "../../src/launch/herdr-client.js";

const OK: CommandResult = { ok: true, code: 0, stdout: "", stderr: "" };
const CLAUDE_SLIDER: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max"];
const CODEX_ORDER: ReasoningEffort[] = ["low", "medium", "high", "xhigh", "max", "ultra"];

export interface FakePaneOptions {
  agent: "claude" | "codex";
  level: ReasoningEffort;
  paneId?: string;
  agentName?: string;
  status?: HerdrAgentState;
  /** Text already typed in the input box (undefined: empty). */
  draft?: string;
  /** Claude: the next switch shows the Bedrock/gateway cache-warning dialog. */
  cacheDialog?: boolean;
  /** Claude: `/effort` does not open the slider. */
  sliderBroken?: boolean;
  /** Codex: Plan mode is active. */
  planMode?: boolean;
  /** Codex: the shortcut keys are ignored (for example a popup is open). */
  ignoreShortcut?: boolean;
  /** Earlier output already on screen. */
  history?: string[];
}

/**
 * A scripted stand-in for a Claude Code or Codex pane driven through Herdr. It models the
 * parts of each TUI the switcher relies on: the input box, the Claude `/effort` slider and
 * its messages, and the Codex reasoning shortcuts, status line, and Tab queue.
 */
export class FakePane implements HerdrPaneClient {
  level: ReasoningEffort;
  readonly paneId: string;
  readonly agentName: string;
  status: HerdrAgentState;
  draft: string;
  recent: string[];
  sliderOpen = false;
  sliderPos = 0;
  queued: string[] = [];
  keys: string[] = [];
  texts: string[] = [];

  constructor(private readonly options: FakePaneOptions) {
    this.level = options.level;
    this.paneId = options.paneId ?? "wJ:p1";
    this.agentName = options.agentName ?? `router-${options.agent}-abc123`;
    this.status = options.status ?? "idle";
    this.draft = options.draft ?? "";
    this.recent = [...(options.history ?? [])];
  }

  async getAgent(target: string): Promise<HerdrAgentInfo | undefined> {
    if (target !== this.agentName) return undefined;
    return { agent: this.options.agent, status: this.status, paneId: this.paneId };
  }

  private screen(ansi: boolean): string {
    const dim = (text: string) => (ansi ? `\u001b[2m${text}\u001b[0m` : text);
    if (this.options.agent === "claude") {
      const lines = [...this.recent.slice(-10)];
      if (this.sliderOpen) {
        lines.push(
          "Effort",
          "Faster ▲ Smarter",
          "←/→ adjust · enter confirm · s for this session only",
        );
      }
      lines.push(
        "─".repeat(40),
        `❯\u00a0${this.draft}`,
        "─".repeat(40),
        `  Opus 5.5 ${this.level} │ repo`,
      );
      return lines.join("\n");
    }
    return [
      ...this.recent.slice(-10),
      this.draft ? `› ${this.draft}` : `› ${dim("Ask Codex to do anything")}`,
      "",
      `  GPT-6-Astra ${this.level} · ~/Code/repo${this.options.planMode ? "   Plan mode (shift+tab to cycle)" : ""}`,
    ].join("\n");
  }

  async readPane(
    paneId: string,
    options: { source: "visible" | "recent"; lines: number; ansi?: boolean },
  ): Promise<string | undefined> {
    if (paneId !== this.paneId) return undefined;
    return this.screen(options.ansi === true);
  }

  async sendText(paneId: string, text: string): Promise<CommandResult> {
    if (paneId !== this.paneId) return { ...OK, ok: false, code: 1 };
    this.texts.push(text);
    this.draft += text;
    return OK;
  }

  async sendKeys(paneId: string, keys: readonly string[]): Promise<CommandResult> {
    if (paneId !== this.paneId) return { ...OK, ok: false, code: 1 };
    for (const key of keys) {
      this.keys.push(key);
      this.press(key);
    }
    return OK;
  }

  private press(key: string): void {
    if (this.options.agent === "claude") {
      if (key === "enter" && this.draft === "/effort") {
        this.draft = "";
        if (!this.options.sliderBroken) {
          this.sliderOpen = true;
          this.sliderPos = CLAUDE_SLIDER.indexOf(this.level);
        }
        return;
      }
      if (this.sliderOpen) {
        if (key === "esc") this.sliderOpen = false;
        if (key === "left") this.sliderPos = Math.max(0, this.sliderPos - 1);
        if (key === "right")
          this.sliderPos = Math.min(CLAUDE_SLIDER.length - 1, this.sliderPos + 1);
        if (key === "s") {
          this.sliderOpen = false;
          const chosen = CLAUDE_SLIDER[this.sliderPos]!;
          if (this.options.cacheDialog) {
            this.recent.push(
              "Change effort level?",
              "❯ 1. Yes, switch to " + chosen,
              "  2. No, go back",
            );
            return;
          }
          this.level = chosen;
          this.recent.push(`  ⎿  Set effort level to ${chosen} (this session only): details`);
        }
        return;
      }
      if (key === "esc" && this.recent.at(-1)?.includes("No, go back")) {
        this.recent.push(`  ⎿  Kept effort level as ${this.level}`);
        return;
      }
      if (key.length === 1) this.draft += key;
      return;
    }
    if (key === "alt+." || key === "alt+,") {
      if (this.options.ignoreShortcut) return;
      const index = CODEX_ORDER.indexOf(this.level);
      const next = key === "alt+." ? Math.min(index + 1, 3) : Math.max(index - 1, 0);
      this.level = CODEX_ORDER[key === "alt+." && index >= 3 ? index : next]!;
      return;
    }
    if (key === "tab" && this.status === "working" && this.draft) {
      this.queued.push(this.draft.trim());
      this.draft = "";
    }
  }
}

export const noSleep = async () => {};

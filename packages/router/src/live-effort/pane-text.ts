import type { ReasoningEffort } from "../domain/model-profile.js";

// Parsers for the text Claude Code 2.1.283 and codex-cli 0.156.1 draw in their TUIs.
// Every parser fails closed: text it does not recognize never reads as "safe to type".

const EFFORT_WORDS = "low|medium|high|xhigh|max|ultra";

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

interface StyledChar {
  char: string;
  dim: boolean;
}

/** Splits one ANSI line into characters, tracking SGR 2 (dim), which both TUIs use for placeholders. */
function styledChars(line: string): StyledChar[] {
  const chars: StyledChar[] = [];
  let dim = false;
  let index = 0;
  while (index < line.length) {
    if (line[index] === "\u001b" && line[index + 1] === "[") {
      const end = line.slice(index + 2).search(/[A-Za-z]/);
      if (end === -1) break;
      const body = line.slice(index + 2, index + 2 + end);
      if (line[index + 2 + end] === "m") {
        for (const code of body === "" ? ["0"] : body.split(";")) {
          if (code === "0" || code === "22") dim = false;
          if (code === "2") dim = true;
        }
      }
      index += 3 + end;
      continue;
    }
    const codePoint = line.codePointAt(index)!;
    const char = String.fromCodePoint(codePoint);
    chars.push({ char, dim });
    index += char.length;
  }
  return chars;
}

const RULE = /^\s*[─━]{8,}/;

/**
 * Codex 0.156.1 animates Braille-pattern particles across the idle input line, drawn in a
 * grey foreground rather than dim. Nobody types Braille into a prompt, so they are ignored.
 */
function isBraille(char: string): boolean {
  const code = char.codePointAt(0)!;
  return code >= 0x2800 && code <= 0x28ff;
}

export type InputLineState = "empty" | "busy" | "unknown";

/**
 * Whether the agent's input box holds text a keystroke would mix into. The input line is
 * the last line starting with the prompt glyph (`❯` in Claude Code, `›` in Codex); Claude
 * wraps a draft onto following lines until the next horizontal rule. Placeholder text is
 * drawn dim and does not count.
 */
export function inputLineState(agent: "claude" | "codex", ansiScreen: string): InputLineState {
  const text = inputLineText(agent, ansiScreen);
  if (text === undefined) return "unknown";
  return text === "" ? "empty" : "busy";
}

/**
 * The text typed in the agent's input box (placeholder and decoration left out), or
 * undefined when no input line is on screen.
 */
export function inputLineText(agent: "claude" | "codex", ansiScreen: string): string | undefined {
  const glyph = agent === "claude" ? "❯" : "›";
  const lines = ansiScreen.replace(/\r/g, "").split("\n");
  let start = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (stripAnsi(lines[index]!).trimStart().startsWith(glyph)) {
      start = index;
      break;
    }
  }
  if (start === -1) {
    return undefined;
  }
  const draft: StyledChar[] = [];
  const first = styledChars(lines[start]!);
  const glyphAt = first.findIndex((item) => item.char === glyph);
  draft.push(...first.slice(glyphAt + 1));
  for (let index = start + 1; index < lines.length; index += 1) {
    const plain = stripAnsi(lines[index]!);
    if (RULE.test(plain) || plain.trim() === "") break;
    if (agent === "codex") break;
    draft.push(...styledChars(lines[index]!));
  }
  return draft
    .filter((item) => !item.dim && item.char !== "\u00a0" && !isBraille(item.char))
    .map((item) => item.char)
    .join("")
    .trim();
}

/**
 * Claude Code's vim mode shows `-- NORMAL --` below the input; typed text there runs as vim
 * commands instead of being inserted, so the router must not type.
 */
export function inVimNormalMode(screen: string): boolean {
  return /-- NORMAL --/.test(stripAnsi(screen));
}

/**
 * Codex marks Plan mode in its footer: `Plan mode (shift+tab to cycle)`, or just `Plan mode`
 * beside the status line. Only the footer (the last non-empty lines) is read, so the words
 * in the conversation above do not count.
 */
export function codexInPlanMode(screen: string): boolean {
  return footerLines(screen).some((line) => /\bPlan mode\b/.test(line));
}

/**
 * The effort in Codex's `model-with-reasoning` status item, for example
 * `GPT-6-Astra medium`. Undefined when the status line is missing or configured without it.
 */
export function codexStatusEffort(screen: string): ReasoningEffort | undefined {
  // Only the footer: conversation text above it could otherwise spoof the level.
  const pattern = new RegExp(`astra\\S*\\s+(${EFFORT_WORDS})\\b`, "gi");
  let found: ReasoningEffort | undefined;
  for (const match of footerLines(screen).join("\n").matchAll(pattern)) {
    found = match[1]!.toLowerCase() as ReasoningEffort;
  }
  return found;
}

/** The last non-empty lines of a screen: where both TUIs draw their status and hints. */
export function footerLines(screen: string, count = 3): string[] {
  return stripAnsi(screen)
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-count);
}

export type ClaudeEffortOutcome =
  | { kind: "session-only"; level: string }
  | { kind: "saved-default"; level: string }
  | { kind: "cache-warning" }
  | { kind: "kept"; level: string }
  | { kind: "capped" };

const CLAUDE_OUTCOMES: {
  pattern: RegExp;
  toOutcome: (match: RegExpExecArray) => ClaudeEffortOutcome;
}[] = [
  {
    // Claude Code prints command results after `⎿`; bare text in the conversation does not count.
    pattern: /^\s*⎿\s+Set effort level to (\w+) \(this session only\)/,
    toOutcome: (match) => ({ kind: "session-only", level: match[1]!.toLowerCase() }),
  },
  {
    pattern: /^\s*⎿\s+Set effort level to (\w+) \(saved as your default/,
    toOutcome: (match) => ({ kind: "saved-default", level: match[1]!.toLowerCase() }),
  },
  {
    pattern: /^\s*⎿\s+Kept effort level as (\w+)/,
    toOutcome: (match) => ({ kind: "kept", level: match[1]!.toLowerCase() }),
  },
  { pattern: /^\s*⎿\s+.*exceeds the cap for/, toOutcome: () => ({ kind: "capped" }) },
];

/**
 * Claude's cache-warning dialog, drawn at the bottom of the screen: its title on a line of
 * its own there. Scrollback is not searched, so the words in the conversation do not count.
 */
export function claudeCacheWarningOpen(screen: string): boolean {
  return footerLines(screen, 12).some((line) => /^\s*Change effort level\?\s*$/.test(line));
}

export interface LocatedOutcome {
  outcome: ClaudeEffortOutcome;
  /** The matching line's text, used to tell a new outcome from one already on screen. */
  line: string;
  /** How many lines matched any outcome pattern in the snapshot. */
  count: number;
  /** How many lines follow the last match: a new outcome sits closer to the bottom. */
  linesAfter: number;
}

/** The last `/effort` outcome in a snapshot of Claude Code's recent output. */
export function lastClaudeOutcome(text: string): LocatedOutcome | undefined {
  const lines = stripAnsi(text).split("\n");
  let last: Omit<LocatedOutcome, "count"> | undefined;
  let count = 0;
  lines.forEach((line, index) => {
    for (const { pattern, toOutcome } of CLAUDE_OUTCOMES) {
      const match = pattern.exec(line);
      if (match) {
        count += 1;
        last = {
          outcome: toOutcome(match),
          line: line.trim(),
          linesAfter: lines.length - 1 - index,
        };
        break;
      }
    }
  });
  return last ? { ...last, count } : undefined;
}

/**
 * The outcome `after` shows that was not already the latest one in `before`; undefined
 * otherwise. Output from an earlier switch stays on screen, so the latest outcome counts as
 * new only if its text differs, more outcomes appear, or it sits closer to the bottom (an
 * older identical line may have scrolled out of the snapshot).
 */
export function newClaudeOutcome(before: string, after: string): ClaudeEffortOutcome | undefined {
  const previous = lastClaudeOutcome(before);
  const current = lastClaudeOutcome(after);
  if (!current) return undefined;
  const isNew =
    !previous ||
    previous.line !== current.line ||
    current.count > previous.count ||
    current.linesAfter < previous.linesAfter;
  return isNew ? current.outcome : undefined;
}

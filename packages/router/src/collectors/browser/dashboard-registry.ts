import { parseAnthropicDashboard } from "./parsers/anthropic-dashboard.js";
import { parseCursorDashboard } from "./parsers/cursor-dashboard.js";
import { parseOpenaiDashboard } from "./parsers/openai-dashboard.js";

export const DASHBOARD_REGISTRY = {
  cursor: {
    parser: parseCursorDashboard,
    selectorHint: "section[data-usage=cursor-dashboard]",
    fragile: true,
  },
  anthropic: {
    parser: parseAnthropicDashboard,
    selectorHint: "div.usage",
    fragile: true,
  },
  openai: {
    parser: parseOpenaiDashboard,
    selectorHint: "p containing 'Usage:'",
    fragile: true,
  },
} as const;

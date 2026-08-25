import { formatNamedParamsForDisplay, isInternalParamValue } from "../shared/format-params.js";
import { colorize } from "../shared/log-format";

// `colorize` is a pure presentation helper shared with the operator log
// (`shared/server-log.ts`); it lives under `src/cli/shared/log-format.ts` and is
// re-exported here so this slice's existing importers keep one import site.
export { colorize } from "../shared/log-format";

const PROMPT_PREVIEW_MAX = 24;
const PROMPT_ARGS_DISPLAY_MAX = 96;

/** First stdout lines for `jaiph run`: file name. */
export function formatJaiphRunningBannerLines(
  fileBasename: string,
): string {
  return `\nJaiph: Running ${fileBasename}\n\n`;
}

/**
 * Normalize log/logerr/logwarn message text before printing to a real terminal.
 * Agent and CLI output often contains `\r` and embedded SGR sequences; raw `\r`
 * moves the cursor and can erase the progress tree prefix, leaving fragments like `ℹ "`.
 */
export function sanitizeMultilineLogForTerminal(message: string): string {
  let s = message.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  s = s.replace(/\u001b\[[0-9;:]*m/g, "");
  return s;
}

export function formatStartLine(
  indent: string,
  kind: string,
  name: string,
  colorEnabled: boolean,
  params?: Array<[string, string]>,
  /** Effective prompt model, rendered as a bare token after the backend when known. */
  model?: string,
): string {
  const prefix = indent.slice(0, -2);
  const marker = colorize("▸", "dim", colorEnabled);
  const kindLabel = colorize(kind, "bold", colorEnabled);
  const dimPrefix = colorize(prefix, "dim", colorEnabled);
  let namePart: string;
  let paramSuffix = "";
  if (kind === "prompt" && params != null && params.length > 0) {
    const previewValue =
      params.map(([, v]) => v).find((v) => !isInternalParamValue(v)) ?? "";
    const oneLine = previewValue.replace(/\s+/g, " ").trim();
    const previewDisplay =
      oneLine.length > PROMPT_PREVIEW_MAX
        ? `${oneLine.slice(0, PROMPT_PREVIEW_MAX)}...`
        : oneLine;
    const escaped = previewDisplay.replace(/\\/g, "\\\\");
    const backendPart = name !== kind ? ` ${name}` : "";
    const modelPart = model != null && model.length > 0 ? ` ${model}` : "";
    const label = `${kindLabel}${backendPart}${modelPart}`;
    namePart = previewDisplay.length > 0 ? `${label} "${escaped}"` : label;
    const restParams = params.filter(([, v]) => !isInternalParamValue(v));
    const skipFirst = restParams.length > 0 && restParams[0][1] === previewValue ? 1 : 0;
    const restForSuffix = restParams.slice(skipFirst);
    paramSuffix =
      restForSuffix.length > 0
        ? colorize(
            formatNamedParamsForDisplay(restForSuffix, { capTotalLength: PROMPT_ARGS_DISPLAY_MAX }),
            "dim",
            colorEnabled,
          )
        : "";
  } else {
    namePart = kind === name ? kindLabel : `${kindLabel} ${name}`;
    const showParams =
      params != null &&
      params.length > 0 &&
      (kind === "def" || kind === "prompt" || kind === "script");
    paramSuffix = showParams
      ? colorize(formatNamedParamsForDisplay(params), "dim", colorEnabled)
      : "";
  }
  return `${dimPrefix}${marker} ${namePart}${paramSuffix}`;
}

/** Non-TTY long-step heartbeat: same indent/prefix as start/end; full line dim when `dimEnabled`. */
export function formatHeartbeatLine(
  indent: string,
  kind: string,
  name: string,
  runningSec: number,
  dimEnabled: boolean,
  /** Effective prompt model, rendered as a bare token after the name when known. */
  model?: string,
): string {
  const prefix = indent.slice(0, -2);
  const modelPart = model != null && model.length > 0 ? ` ${model}` : "";
  const body = `${prefix}\u00b7 ${kind} ${name}${modelPart} (running ${runningSec}s)`;
  return colorize(body, "dim", dimEnabled);
}

export function formatCompletedLine(
  indent: string,
  status: number,
  elapsedSec: number,
  colorEnabled: boolean,
  kind?: string,
  name?: string,
  /** Effective prompt model, rendered as a bare token after the name when known. */
  model?: string,
): string {
  const prefix = indent.slice(0, -2);
  const dimPrefix = colorize(prefix, "dim", colorEnabled);
  const modelPart = model != null && model.length > 0 ? ` ${model}` : "";
  const label = kind != null && name != null ? `${kind} ${name}${modelPart} ` : "";
  if (status === 0) {
    const ok = colorize("✓", "green", colorEnabled);
    const elapsed = colorize(`${label}(${elapsedSec}s)`, "dim", colorEnabled);
    return `${dimPrefix}${ok} ${elapsed}`;
  }
  const fail = colorize(`✗ ${label}(${elapsedSec}s)`, "red", colorEnabled);
  return `${dimPrefix}${fail}`;
}

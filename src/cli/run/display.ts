import { formatNamedParamsForDisplay, isInternalParamValue } from "../commands/format-params.js";

const PROMPT_PREVIEW_MAX = 24;
const PROMPT_ARGS_DISPLAY_MAX = 96;

export function colorize(
  text: string,
  code: "dim" | "bold" | "green" | "red",
  colorEnabled: boolean,
): string {
  if (!colorEnabled) return text;
  const prefix =
    code === "dim" ? "\u001b[2m"
    : code === "bold" ? "\u001b[1m"
    : code === "green" ? "\u001b[32m"
    : "\u001b[31m";
  return `${prefix}${text}\u001b[0m`;
}

export function formatStartLine(
  indent: string,
  kind: string,
  name: string,
  colorEnabled: boolean,
  params?: Array<[string, string]>,
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
    const escaped = previewDisplay.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    namePart = previewDisplay.length > 0 ? `${kindLabel} "${escaped}"` : `${kindLabel} ${name}`;
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
      (kind === "workflow" || kind === "prompt" || kind === "script" || kind === "rule");
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
): string {
  const prefix = indent.slice(0, -2);
  const body = `${prefix}\u00b7 ${kind} ${name} (running ${runningSec}s)`;
  return colorize(body, "dim", dimEnabled);
}

export function formatCompletedLine(
  indent: string,
  status: number,
  elapsedSec: number,
  colorEnabled: boolean,
  kind?: string,
  name?: string,
): string {
  const prefix = indent.slice(0, -2);
  const dimPrefix = colorize(prefix, "dim", colorEnabled);
  const label = kind != null && name != null ? `${kind} ${name} ` : "";
  if (status === 0) {
    const ok = colorize("✓", "green", colorEnabled);
    const elapsed = colorize(`${label}(${elapsedSec}s)`, "dim", colorEnabled);
    return `${dimPrefix}${ok} ${elapsed}`;
  }
  const fail = colorize(`✗ ${label}(${elapsedSec}s)`, "red", colorEnabled);
  return `${dimPrefix}${fail}`;
}

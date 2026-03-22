import type { StepEvent, LogEvent } from "./events";
import type { HookPayload } from "../../types";

export type StepStartData = {
  event: StepEvent;
  eventId: string;
  depth: number;
  isRoot: boolean;
};

export type StepEndData = {
  event: StepEvent;
  eventId: string;
  isRoot: boolean;
};

export type RunEventMap = {
  step_start: StepStartData;
  step_end: StepEndData;
  log: LogEvent;
  stderr_line: { line: string };
  workflow_start: HookPayload;
  workflow_end: HookPayload;
};

export type RunEmitter = {
  on<K extends keyof RunEventMap>(event: K, cb: (data: RunEventMap[K]) => void): void;
  emit<K extends keyof RunEventMap>(event: K, data: RunEventMap[K]): void;
};

export function createRunEmitter(): RunEmitter {
  const listeners = new Map<string, Array<(data: any) => void>>();
  return {
    on(event, cb) {
      const list = listeners.get(event) ?? [];
      if (!listeners.has(event)) listeners.set(event, list);
      list.push(cb as (data: any) => void);
    },
    emit(event, data) {
      const list = listeners.get(event);
      if (!list) return;
      for (const cb of list) cb(data);
    },
  };
}

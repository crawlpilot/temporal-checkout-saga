import Long from 'long';
import { temporal } from '@temporalio/proto';

type History = temporal.api.history.v1.IHistory;

const NAMES: Record<number, string> = {
  1: 'WorkflowExecutionStarted', 2: 'WorkflowExecutionCompleted', 3: 'WorkflowExecutionFailed',
  5: 'WorkflowTaskScheduled', 6: 'WorkflowTaskStarted', 7: 'WorkflowTaskCompleted', 8: 'WorkflowTaskTimedOut',
  10: 'ActivityTaskScheduled', 11: 'ActivityTaskStarted', 12: 'ActivityTaskCompleted', 13: 'ActivityTaskFailed', 14: 'ActivityTaskTimedOut',
};

/** Plain JSON for a fetched history: Longs as strings, JSON payloads decoded, stack traces dropped. */
export function toPlain(v: unknown): unknown {
  if (v == null) return v;
  if (Long.isLong(v)) return v.toString();
  if (v instanceof Uint8Array) {
    const text = Buffer.from(v).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (Array.isArray(v)) return v.map(toPlain);
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'stackTrace') continue;
      const p = toPlain(x);
      if (p !== undefined && !(Array.isArray(p) && p.length === 0)) out[k] = p;
    }
    return out;
  }
  return v;
}

/** One line per activity event: id, type, activity, attempt and failure, as recorded. */
export function summarize(history: History): string[] {
  const scheduled = new Map<string, string>();
  const lines: string[] = [];
  for (const e of history.events ?? []) {
    const id = String(e.eventId);
    const type = NAMES[Number(e.eventType)] ?? `event ${e.eventType}`;
    if (type.startsWith('WorkflowTask')) continue;
    const sched = e.activityTaskScheduledEventAttributes;
    if (sched) scheduled.set(id, sched.activityType?.name ?? '?');
    const ref = e.activityTaskStartedEventAttributes?.scheduledEventId ?? e.activityTaskCompletedEventAttributes?.scheduledEventId ?? e.activityTaskFailedEventAttributes?.scheduledEventId;
    const activity = sched?.activityType?.name ?? (ref ? scheduled.get(String(ref)) : undefined);
    const started = e.activityTaskStartedEventAttributes;
    const failure = e.activityTaskFailedEventAttributes?.failure ?? e.workflowExecutionFailedEventAttributes?.failure;
    const extra = [
      activity,
      started && started.attempt && started.attempt > 1 ? `attempt ${started.attempt}, last failure: ${started.lastFailure?.message}` : '',
      failure ? `failure: ${failure.cause?.message ?? failure.message}` : '',
    ].filter(Boolean).join('  ');
    lines.push(`${id.padStart(3)} ${type}${extra ? `  ${extra}` : ''}`);
  }
  return lines;
}

/**
 * Temporal's own binary encoding of a history, for replay tests (`Worker.runReplayHistory`).
 * Stack traces are blanked so a committed fixture never carries local file paths.
 */
export function encodeHistory(history: History): Buffer {
  const copy = temporal.api.history.v1.History.decode(temporal.api.history.v1.History.encode(history).finish());
  const blank = (o: unknown): void => {
    if (!o || typeof o !== 'object') return;
    for (const [k, v] of Object.entries(o)) {
      if (k === 'stackTrace') (o as Record<string, unknown>)[k] = '';
      else blank(v);
    }
  };
  blank(copy);
  return Buffer.from(temporal.api.history.v1.History.encode(copy).finish());
}

export function decodeHistory(bytes: Uint8Array): temporal.api.history.v1.History {
  return temporal.api.history.v1.History.decode(bytes);
}

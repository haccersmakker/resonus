import type { ListeningSessionControl } from './listeningSessions';

type ControlHandler = (control: ListeningSessionControl) => boolean;
type QueueEditGuard = () => boolean;

let controlHandler: ControlHandler | null = null;
let queueEditGuard: QueueEditGuard | null = null;
let bypassDepth = 0;

/** Installed once by the Jam store, kept separate to avoid store import cycles. */
export function registerListeningSessionBridge(
  onControl: ControlHandler,
  shouldBlockQueueEdit: QueueEditGuard,
): () => void {
  controlHandler = onControl;
  queueEditGuard = shouldBlockQueueEdit;
  return () => {
    if (controlHandler === onControl) controlHandler = null;
    if (queueEditGuard === shouldBlockQueueEdit) queueEditGuard = null;
  };
}

/** True means the authoritative room owns this action and local code must stop. */
export function handleListeningSessionControl(control: ListeningSessionControl): boolean {
  if (bypassDepth > 0) return false;
  return controlHandler?.(control) ?? false;
}

export function listeningSessionBlocksQueueEdits(): boolean {
  return bypassDepth === 0 && (queueEditGuard?.() ?? false);
}

/**
 * Starts an authoritative remote action without turning its synchronous store
 * mutations into a new room request.
 *
 * The bypass deliberately ends as soon as `run` returns, even when it returns
 * a Promise. Holding this process-wide flag across native loading or seeking
 * would let an unrelated user tap bypass host authority while that work was in
 * flight.
 */
export function withListeningSessionBypass<T>(run: () => T): T {
  bypassDepth += 1;
  try {
    return run();
  } finally {
    bypassDepth -= 1;
  }
}

import type { ServerMsg } from "./protocol";

/** Route deps receive an optional hub broadcaster; production wires it in index.ts. */
export type Broadcast = (message: ServerMsg) => Promise<void>;

/**
 * Real-time delivery is best effort: a hub hiccup must never fail the HTTP
 * request that already changed state.
 */
export async function notify(
  broadcast: Broadcast | undefined,
  message: ServerMsg,
): Promise<void> {
  if (broadcast === undefined) return;
  try {
    await broadcast(message);
  } catch {
    // Swallowed on purpose; callers have nothing useful to do about it.
  }
}

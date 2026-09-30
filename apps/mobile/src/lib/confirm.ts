/**
 * The app's custom alert, callable from anywhere.
 *
 * `openConfirm({ ... })` puts the one `<ConfirmDialogHost />` at the app root on
 * screen — the blurred backdrop, the iOS-shaped card, and the confirm button
 * that turns into a spinner while the work it started is still running. When a
 * screen needs to ask "are you sure?", this is the call; `Alert.alert` is not.
 *
 * ## Why a plain module rather than context or Redux
 *
 * Same reasoning as `lib/asset-viewer.ts` and `lib/upload-queue.ts`. Questions
 * are asked from event handlers, list rows and gesture callbacks, and threading
 * a dispatch through every one of those means every call site takes a prop it
 * does not otherwise need. It is also state with no meaning after a relaunch, so
 * it must not reach `redux-persist`.
 *
 * ## The work goes *into* the request
 *
 * The obvious API is `const ok = await confirm(...)`, and it is the wrong one
 * here: it resolves the moment the button is pressed, which means the dialog is
 * already gone before the delete it authorised has left the phone — exactly the
 * silence this dialog exists to remove. So the caller hands over the work
 * itself, and the dialog stays up and spins until it settles.
 */

export type ConfirmRequest = {
  /**
   * The action that walks away. Defaults to the iOS wording.
   *
   * `null` makes it a one-button alert: nothing to choose, only something to
   * acknowledge. The backdrop stops cancelling it and Android's back button
   * runs the one action instead, because there is no second answer for either
   * of them to give.
   */
  cancelLabel?: string | null;
  confirmLabel: string;
  /** Paints the confirm red. Off for a confirm that only commits something. */
  destructive?: boolean;
  /**
   * Set when the request is opened, not by the caller. It is what keys the card
   * so that two questions in a row cannot share one.
   */
  id?: number;
  message?: string;
  /**
   * Runs when the cancel *button* is pressed — not the backdrop or back —
   * for a question whose second answer is itself a path ("Normal
   * registration"), not just walking away.
   */
  onCancel?: () => void;
  /**
   * The work itself. While the promise is pending the dialog stays up, the
   * confirm button spins and neither action can be pressed; when it settles the
   * dialog closes.
   *
   * Report failure the way the screen already does — a toast — rather than by
   * rejecting for the dialog to render: by the time it settles the dialog is on
   * its way out, and an error that appears inside a closing card is one nobody
   * reads.
   */
  onConfirm: () => Promise<void> | void;
  title: string;
};

let state: ConfirmRequest | null = null;
let counter = 0;
const listeners = new Set<() => void>();

function emit(next: ConfirmRequest | null) {
  state = next;

  for (const listener of listeners) {
    listener();
  }
}

export function subscribeToConfirm(listener: () => void) {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Must return the same reference until something changes —
 * `useSyncExternalStore` compares by identity, and a fresh object every call is
 * an infinite render loop.
 */
export function getConfirmRequest(): ConfirmRequest | null {
  return state;
}

/**
 * Asks the question. The newest one wins: a second call replaces whatever is on
 * screen rather than queueing behind it, because two stacked confirmations is
 * never the intended reading of two taps.
 */
export function openConfirm(request: ConfirmRequest) {
  counter += 1;
  emit({ ...request, id: counter });

  return counter;
}

/**
 * Closes whatever is on screen — or, given the id `openConfirm` returned, only
 * that request. A screen that opened an alert on mount closes it on unmount
 * with its own id, so leaving cannot take down a question somebody else asked.
 */
export function closeConfirm(id?: number) {
  if (state !== null && (id === undefined || state.id === id)) {
    emit(null);
  }
}

/**
 * Reactive store backing the global confirm dialog. Anywhere in the app
 * can push a request onto this state and the dialog component will
 * render it and run the callback when the user confirms — so prompts
 * don't have to be wired through the component tree.
 */

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void | Promise<void>;
  /** When true, render as a one-button notice (no Cancel). The `onConfirm`
   *  callback is optional in this mode. */
  alert?: boolean;
};

class ConfirmState {
  pending = $state<ConfirmRequest | null>(null);

  request(req: ConfirmRequest) {
    this.pending = req;
  }

  /** Shortcut for a single-button error notice. */
  alert(opts: { title: string; message: string; confirmLabel?: string }) {
    this.pending = {
      title: opts.title,
      message: opts.message,
      confirmLabel: opts.confirmLabel ?? "OK",
      alert: true,
      onConfirm: () => {},
    };
  }

  cancel() {
    this.pending = null;
  }

  async confirm() {
    const p = this.pending;
    this.pending = null;
    if (p) await p.onConfirm();
  }
}

export const confirmState = new ConfirmState();

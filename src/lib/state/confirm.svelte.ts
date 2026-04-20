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
};

class ConfirmState {
  pending = $state<ConfirmRequest | null>(null);

  request(req: ConfirmRequest) {
    this.pending = req;
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

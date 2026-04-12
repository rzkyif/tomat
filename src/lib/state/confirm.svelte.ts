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

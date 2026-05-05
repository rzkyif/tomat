/**
 * Reactive store backing the global bubble-color picker. ColorField
 * pushes a request here when the user clicks its swatch; ColorPickerModal
 * (rendered alongside ConfirmModal in the settings Bubble) renders the
 * popup. Routing through state instead of mounting the popup inline
 * keeps it inside the click-through `contentEl` and inside the Bubble's
 * positioning context.
 */

type ColorPickerRequest = {
  /** Element the popup positions itself relative to. */
  anchor: HTMLElement;
  /** Hex (8-char) the popup opens with. */
  initialHex: string;
  /** Called when the user commits via the Apply button or Enter. */
  onApply: (hex: string) => void;
};

class ColorPickerState {
  pending = $state<ColorPickerRequest | null>(null);

  open(req: ColorPickerRequest) {
    this.pending = req;
  }

  close() {
    this.pending = null;
  }

  apply(hex: string) {
    const p = this.pending;
    this.pending = null;
    p?.onApply(hex);
  }
}

export const colorPickerState = new ColorPickerState();

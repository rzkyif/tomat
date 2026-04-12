let currentController: AbortController | null = null;

export function setInterruptController(controller: AbortController | null): void {
  currentController = controller;
}

export function interruptCurrentStream(): void {
  if (currentController) {
    currentController.abort();
    currentController = null;
  }
}

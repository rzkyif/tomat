/**
 * Holds a reference to the abort controller for the LLM request currently
 * streaming, so any part of the app can cancel it without having to pass
 * the controller around.
 */

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

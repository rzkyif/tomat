<script lang="ts">
  import { errMessage } from "@tomat/shared";
  import { passwordPromptState } from "$stores/password-prompt.svelte";
  import Modal from "@tomat/shared/ui/components/primitives/Modal.svelte";
  import Button from "@tomat/shared/ui/components/primitives/Button.svelte";
  import Input from "@tomat/shared/ui/components/primitives/Input.svelte";
  import FormField from "@tomat/shared/ui/components/primitives/FormField.svelte";
  import Alert from "@tomat/shared/ui/components/primitives/Alert.svelte";

  // Local field state, reset whenever a new request arrives so one prompt's
  // input or error can't leak into the next.
  let password = $state("");
  let submitting = $state(false);
  let error = $state<string | null>(null);
  $effect(() => {
    if (passwordPromptState.pending) {
      password = "";
      submitting = false;
      error = null;
    }
  });

  async function submit() {
    const p = passwordPromptState.pending;
    if (!p || submitting || !password) return;
    submitting = true;
    error = null;
    try {
      await p.onSubmit(password);
      // Success closes the modal. The request resolved its own work.
      passwordPromptState.pending = null;
    } catch (e) {
      // Wrong password (or any failure): stay open and let the user retry.
      error = errMessage(e);
      submitting = false;
    }
  }
</script>

{#if passwordPromptState.pending}
  {@const p = passwordPromptState.pending}
  <Modal
    open
    onclose={() => passwordPromptState.cancel()}
    ariaLabel={p.title}
  >
    <div class="text-default-800 font-medium">{p.title}</div>
    {#if p.message}
      <div class="text-default-600 text-sm whitespace-pre-line">{p.message}</div>
    {/if}
    <FormField label="Admin password">
      <Input
        type="password"
        value={password}
        ariaLabel="Admin password"
        placeholder="••••••••"
        disabled={submitting}
        oninput={(v) => {
          password = v;
          error = null;
        }}
        onkeydown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
    </FormField>
    {#if error}
      <Alert variant="error">{error}</Alert>
    {/if}
    <div class="flex items-center justify-end gap-2">
      <Button variant="secondary" disabled={submitting} onclick={() => passwordPromptState.cancel()}>
        Cancel
      </Button>
      <Button variant="primary" loading={submitting} disabled={!password} onclick={() => void submit()}>
        {p.confirmLabel ?? "Continue"}
      </Button>
    </div>
  </Modal>
{/if}

<script lang="ts">
  // Add-a-core wizard. It is the only reachable mode while no core is paired
  // (viewState.locked: first launch, or after the last core is removed), and is
  // also launched from the Cores settings manager to add an additional core.
  // When adding an additional core and a local core is already paired, the
  // local/remote chooser is skipped (a second local install is unsupported).
  //
  // The state machine + pairing flows live in the NewCoreWizard composable; this
  // shell owns the `$effect`s and the onMount kick-off, and feeds the live state
  // into the presentational NewCoreWizardView.

  import { onMount } from "svelte";
  import NewCoreWizardView from "@tomat/shared/ui/components/new-core/NewCoreWizardView.svelte";
  import { MIN_ADMIN_PASSWORD_LENGTH } from "@tomat/shared";
  import { useUiContext } from "@tomat/shared/ui/context";
  import { settingsState, viewState } from "$stores";
  import { backState } from "$stores/back.svelte";
  import { hostFromUrl, NewCoreWizard } from "$composables/use-new-core-wizard.svelte";

  // Mobile is remote-only: no on-device core to install, so the local/remote
  // chooser and the whole local-install branch are skipped (see
  // decideInitialView) and the wizard renders full-screen rather than in a
  // fixed-width bubble.
  const onMobile = useUiContext().platform === "mobile";
  const wizard = new NewCoreWizard(onMobile);

  let alignment = $derived(settingsState.getAlignment());

  // The manual page covering how to install and run a Core elsewhere.
  const CORE_SETUP_DOCS_URL = "https://au.tomat.ing/manual/settings/installing-a-core";

  // The Android back button steps the wizard back when a previous step exists,
  // mirroring the header arrow, before the global chain (mode / root) sees it.
  // Pushed once; the closure reads the live `canStepBack` / `busy` at press time.
  $effect(() => {
    return backState.push(() => {
      if (wizard.canStepBack && wizard.busy === null) {
        wizard.goBack();
        return true;
      }
      return false;
    });
  });

  onMount(() => {
    wizard.init();
  });

  // Stale-check the connection state whenever the URL field changes: the
  // ok/version snapshot is only meaningful for the URL we actually probed.
  $effect(() => {
    const _ = wizard.remoteUrl;
    if (
      wizard.connectionStatus.kind === "ok" &&
      wizard.connectionStatus.checkedUrl !== wizard.normalizedRemoteUrl()
    ) {
      wizard.connectionStatus = { kind: "idle" };
    }
  });
</script>

<NewCoreWizardView
  step={wizard.view}
  {onMobile}
  locked={viewState.locked}
  {alignment}
  busy={wizard.busy}
  error={wizard.error}
  canStepBack={wizard.canStepBack}
  destination={wizard.destination}
  coreSetupDocsUrl={CORE_SETUP_DOCS_URL}
  discovering={wizard.discovering}
  didSweep={wizard.didSweep}
  discovered={wizard.discovered.map((c) => ({
    pin: c.pin,
    hostLabel: hostFromUrl(c.baseUrl),
    version: c.version,
  }))}
  connectionError={wizard.connectionStatus.kind === "error"
    ? wizard.connectionStatus.message
    : null}
  defaultRemoteName={wizard.defaultRemoteName}
  remoteCodeValid={/^\d{6}$/.test(wizard.remoteCode)}
  installServiceChoice={wizard.installServiceChoice}
  installNetworkChoice={wizard.installNetworkChoice}
  minAdminPasswordLength={MIN_ADMIN_PASSWORD_LENGTH}
  installPasswordValid={wizard.installPasswordValid}
  onStepBack={() => wizard.goBack()}
  onClose={() => wizard.exitFlow()}
  onChooseDestination={(d) => (wizard.destination = d)}
  onContinueFromChoose={() => wizard.continueFromChoose()}
  onPingNetwork={() => wizard.pingNetwork()}
  onUseDiscovered={(row) => {
    const found = wizard.discovered.find((c) => c.pin === row.pin);
    if (found) wizard.useDiscovered(found);
  }}
  onCheckConnection={() => wizard.checkConnection()}
  onToggleService={() => (wizard.installServiceChoice = !wizard.installServiceChoice)}
  onToggleNetwork={() => (wizard.installNetworkChoice = !wizard.installNetworkChoice)}
  onPairLocal={() => wizard.pairLocal()}
  onPairRemote={() => wizard.pairRemote()}
  bind:remoteUrl={wizard.remoteUrl}
  bind:remoteName={wizard.remoteName}
  bind:remoteCode={wizard.remoteCode}
  bind:installPassword={wizard.installPassword}
  bind:installPasswordConfirm={wizard.installPasswordConfirm}
/>

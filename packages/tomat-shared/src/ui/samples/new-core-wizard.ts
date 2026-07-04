import type { ComponentProps } from "svelte";
import type { OmitSnippetProps } from "./types.ts";
import type NewCoreWizardView from "../components/new-core/NewCoreWizardView.svelte";

const DOCS_URL = "https://au.tomat.ing/manual/maintenance/cores";

export const newCoreWizardSamples = {
  // Step 1: destination chooser, onboarding (locked) welcome header.
  chooseDestination: {
    step: "chooseDestination",
    locked: true,
    destination: "local",
    coreSetupDocsUrl: DOCS_URL,
    minAdminPasswordLength: 8,
  },
  // Remote step 1: address entry, with a finished sweep listing one core.
  remoteAddress: {
    step: "remoteAddress",
    canStepBack: true,
    coreSetupDocsUrl: DOCS_URL,
    didSweep: true,
    discovered: [{ pin: "a1b2", hostLabel: "studio.local:7800", version: "0.4.1" }],
    remoteUrl: "https://192.168.1.20:7800",
    minAdminPasswordLength: 8,
  },
  // Remote step 2: name + 6-digit pairing code (valid, Pair button shown).
  remotePair: {
    step: "remotePair",
    canStepBack: true,
    coreSetupDocsUrl: DOCS_URL,
    defaultRemoteName: "192.168.1.20:7800",
    remoteName: "Studio Core",
    remoteCode: "482915",
    remoteCodeValid: true,
    minAdminPasswordLength: 8,
  },
  // Connecting: checking a remote address (spinner on the Check button).
  connecting: {
    step: "remoteAddress",
    canStepBack: true,
    coreSetupDocsUrl: DOCS_URL,
    busy: "checking",
    remoteUrl: "https://192.168.1.20:7800",
    minAdminPasswordLength: 8,
  },
  // Error: a failed connection check on the remote-address step.
  error: {
    step: "remoteAddress",
    canStepBack: true,
    coreSetupDocsUrl: DOCS_URL,
    remoteUrl: "https://192.168.1.20:7800",
    connectionError: "Could not reach Core: connection timed out",
    minAdminPasswordLength: 8,
  },
  // Local-confirm: install toggles + admin password (valid, ready to install).
  localConfirm: {
    step: "localConfirm",
    canStepBack: true,
    coreSetupDocsUrl: DOCS_URL,
    installServiceChoice: false,
    installNetworkChoice: false,
    installBehindProxyChoice: true,
    installPassword: "hunter2!",
    installPasswordConfirm: "hunter2!",
    installPasswordValid: true,
    minAdminPasswordLength: 8,
  },
  // Installing: the local install is running (spinner on the primary button,
  // controls disabled), the button narrating the installer's current phase with
  // a running percentage, so the "Continue in the Background" escape hatch shows
  // below it, letting the user drop the always-on-top setup window to the tray.
  installing: {
    step: "localConfirm",
    canStepBack: true,
    coreSetupDocsUrl: DOCS_URL,
    busy: "installing",
    installProgress: { label: "Downloading the Core", done: 2, total: 6 },
    installServiceChoice: false,
    installNetworkChoice: false,
    installPassword: "hunter2!",
    installPasswordConfirm: "hunter2!",
    installPasswordValid: true,
    minAdminPasswordLength: 8,
  },
} satisfies Record<string, OmitSnippetProps<ComponentProps<typeof NewCoreWizardView>>>;

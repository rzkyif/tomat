// Sample prop bundles for every shared `*View`, consumed by the website gallery
// (one card per View per scenario), the showcase stages, and the manual. Each
// View's samples are typed against its props, so a prop rename fails
// svelte-check; snippet props are supplied by the renderer. The `SAMPLES`
// registry is keyed by the exact View component name (`FooView`) so the
// check-view-coverage walker can assert every View has samples here.

export { agentMessageSamples, AGENT_ANSWER, AGENT_REASONING } from "./agent-message.ts";
export { attachmentListSamples } from "./attachment-list.ts";
export { diffViewSamples } from "./diff-view.ts";
export { errorMessageSamples } from "./error-message.ts";
export { expandableMessageSamples } from "./expandable-message.ts";
export { quickModelBarSamples } from "./quick-model-bar.ts";
export { reasoningTraceSamples } from "./reasoning-trace.ts";
export { relevantDocumentsSamples } from "./relevant-documents.ts";
export { relevantToolsSamples } from "./relevant-tools.ts";
export { sessionBarSamples } from "./session-bar.ts";
export { settingsContentSamples } from "./settings-content.ts";
export { settingsFieldSamples } from "./settings-field.ts";
export { settingsHeaderSamples } from "./settings-header.ts";
export { settingsShellSamples } from "./settings-shell.ts";
export { settingsSidebarSamples } from "./settings-sidebar.ts";
export { snippetAutocompleteSamples } from "./snippet-autocomplete.ts";
export { toolCallSamples } from "./tool-call.ts";
export { userInputSamples } from "./user-input.ts";
export { userMessageSamples } from "./user-message.ts";
export { SAMPLE_FIRST_GROUP, SAMPLE_GROUPS, SAMPLE_VALUES } from "./settings-groups.ts";

import { agentMessageSamples } from "./agent-message.ts";
import { attachmentListSamples } from "./attachment-list.ts";
import { diffViewSamples } from "./diff-view.ts";
import { errorMessageSamples } from "./error-message.ts";
import { expandableMessageSamples } from "./expandable-message.ts";
import { quickModelBarSamples } from "./quick-model-bar.ts";
import { reasoningTraceSamples } from "./reasoning-trace.ts";
import { relevantDocumentsSamples } from "./relevant-documents.ts";
import { relevantToolsSamples } from "./relevant-tools.ts";
import { sessionBarSamples } from "./session-bar.ts";
import { settingsContentSamples } from "./settings-content.ts";
import { settingsFieldSamples } from "./settings-field.ts";
import { settingsHeaderSamples } from "./settings-header.ts";
import { settingsShellSamples } from "./settings-shell.ts";
import { settingsSidebarSamples } from "./settings-sidebar.ts";
import { snippetAutocompleteSamples } from "./snippet-autocomplete.ts";
import { toolCallSamples } from "./tool-call.ts";
import { userInputSamples } from "./user-input.ts";
import { userMessageSamples } from "./user-message.ts";

/** View component name -> its named sample scenarios. The check-view-coverage
 *  walker asserts every `*View.svelte` appears as a key here. */
export const SAMPLES = {
  AgentMessageView: agentMessageSamples,
  AttachmentListView: attachmentListSamples,
  DiffView: diffViewSamples,
  ErrorMessageView: errorMessageSamples,
  ExpandableMessageView: expandableMessageSamples,
  QuickModelBarView: quickModelBarSamples,
  ReasoningTraceView: reasoningTraceSamples,
  RelevantDocumentsView: relevantDocumentsSamples,
  RelevantToolsView: relevantToolsSamples,
  SessionBarView: sessionBarSamples,
  SettingsContentView: settingsContentSamples,
  SettingsFieldView: settingsFieldSamples,
  SettingsHeaderView: settingsHeaderSamples,
  SettingsShellView: settingsShellSamples,
  SettingsSidebarView: settingsSidebarSamples,
  SnippetAutocompleteView: snippetAutocompleteSamples,
  ToolCallView: toolCallSamples,
  UserInputView: userInputSamples,
  UserMessageView: userMessageSamples,
} as const;

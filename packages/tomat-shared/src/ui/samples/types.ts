// Snippet props are supplied by the gallery/showcase renderer at render time (a
// snippet cannot live in a `.ts` sample), so they are excluded from a sample
// bundle's type. Everything else - including REQUIRED data props - stays
// required, so a sample that drops a required prop fails svelte-check (the drift
// `Partial<ComponentProps<...>>` used to hide). The names below are the snippet
// props declared across the shared Views; add to the union when a View gains a
// new snippet prop. `title` and `field` are deliberately excluded: they are
// snippet props on some primitives but DATA props on Views (a string title on
// ExpandableMessageView, a SettingField on SettingsFieldView), so omitting them
// would wrongly strip a required data prop from those samples.
type SnippetPropName =
  | "actions"
  | "attachmentRow"
  | "attachmentSlot"
  | "badge"
  | "badges"
  | "belowContent"
  | "belowHeader"
  | "body"
  | "children"
  | "complexField"
  | "contentOverride"
  | "documentContent"
  | "editBody"
  | "footer"
  | "groupContent"
  | "leading"
  | "prefix"
  | "rightSlot"
  | "searchContent"
  | "sidebarFooter"
  | "topSlot"
  | "trailing";

/** A View's props minus its snippet props: the shape a sample bundle provides. */
export type OmitSnippetProps<P> = Omit<P, SnippetPropName>;

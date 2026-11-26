/**
 * The editor's words. English is built in; the dashboard sends the same keys
 * in the marketer's language with `joryio:editor-context` (`strings`, plus
 * `dir` for Hebrew and Arabic), so the five dashboard locales reach the
 * editor without shipping every translation to the customer's site. A key
 * the dashboard does not send stays English. `{name}` placeholders are
 * filled with text, never parsed as HTML.
 */
export const EDITOR_STRINGS = {
  title: 'Joryio editor',
  variant: 'Variant {name}',
  hintPoint: 'Point at anything on the page',
  hintEditing: 'Editing · changes show live',
  editsOne: '1 edit',
  editsMany: '{n} edits',
  noEdits: 'No edits yet.',
  undo: 'Undo last edit',
  undoOffline: 'Undo is available once the Joryio dashboard is connected',
  saveReturn: 'Save & return to Joryio',
  clickToEdit: 'click to edit',
  helpTitle: 'Not the right box?',
  helpUp: 'Select the section around it',
  helpDown: 'Select something inside it',
  helpClickKey: 'Click',
  helpClick: 'Edit this one',
  dismiss: 'Dismiss',
  page: 'Page',
  up: 'Select the element around it',
  down: 'Select the first element inside it',
  matchOne: '1 match on page',
  matchMany: 'Matches {n} - all will change',
  matchNone: 'Not found',
  whatToDo: 'What do you want to do?',
  actText: 'Change text',
  actLink: 'Change link',
  actImage: 'Change image',
  actHide: 'Hide it',
  actSlot: 'Add content slot',
  noText: 'No text here',
  notLink: 'Not a link',
  notImage: 'Not an image',
  newText: 'New text',
  was: 'Was: "{value}"',
  insert: 'Insert',
  fallbackFor: 'If {name} is missing',
  fallbackHelp: "Shown to visitors we don't know yet.",
  fallbackBad: 'Plain text only - no Liquid here.',
  fallbackDone: 'Done',
  liquid: 'Liquid code',
  more: 'More…',
  search: 'Search fields',
  noMatch: 'No matching fields',
  groupProfile: 'Profile',
  groupCustom: 'Custom fields',
  rawNote: 'Shown as code: this text uses Liquid beyond profile fields and fallbacks.',
  newLink: 'New link address',
  newImage: 'New image address',
  urlBad: 'Enter an address starting with https:// (or http://).',
  hideNote: "The {kind} is removed for people in this campaign's audience. Everyone else still sees it.",
  hiddenFor: 'Hidden for this audience',
  slotName: 'Slot name',
  savedAs: 'Saved as',
  slotHelp: 'Filled by a Placement campaign or a journey step.',
  slotEmpty: 'Enter a name for the slot.',
  slotCreate: 'Create content for this slot →',
  slotIn: 'In this slot:',
  slotAddAnother: '+ Add another campaign',
  where: 'Where',
  posBefore: 'Above it',
  posAfter: 'Below it',
  posReplace: 'Instead of it',
  posPrepend: 'Inside, at the start',
  posAppend: 'Inside, at the end',
  slotPreview: 'Content slot',
  view: 'View',
  viewDesktop: 'Desktop',
  viewMobile: 'Mobile',
  appliesTo: 'Applies to',
  devAll: 'All devices',
  devMobile: 'Mobile only',
  devDesktop: 'Desktop only',
  deviceHidden: 'Not shown in this view - switch to the other view to see it.',
  frameBlocked: 'This site does not allow itself to be shown in a frame, so the mobile view cannot open. Make this window narrower than 768 px to see and edit the mobile layout.',
  css: 'CSS selector',
  cssHelp: 'For developers. Matches {n} on this page.',
  cssBad: 'Not a selector this page can use.',
  cancel: 'Cancel',
  save: 'Save · {action}',
  noSelector: 'This element has no stable selector. Choose the element around it (arrow up) or another one.',
  kHeading: 'Heading',
  kText: 'Text',
  kLink: 'Link',
  kButton: 'Button',
  kImage: 'Image',
  kList: 'List',
  kSection: 'Section',
  kMain: 'Main',
  kHeader: 'Header',
  kFooter: 'Footer',
  kNav: 'Navigation',
  kForm: 'Form',
  kElement: 'Element',
};

export type EditorStringKey = keyof typeof EDITOR_STRINGS;
export type EditorStrings = Record<EditorStringKey, string>;

/** The built-in English, with the dashboard's translations over it (strings only, at most 500 characters each). */
export function mergeStrings(over: unknown): EditorStrings {
  const out: EditorStrings = { ...EDITOR_STRINGS };
  if (over && typeof over === 'object') {
    for (const k of Object.keys(EDITOR_STRINGS) as EditorStringKey[]) {
      const v = (over as Record<string, unknown>)[k];
      if (typeof v === 'string' && v.trim() && v.length <= 500) out[k] = v;
    }
  }
  return out;
}

/** `{name}` placeholders filled in; the result is only ever set as text. */
export function fill(text: string, vars: Record<string, string | number> = {}): string {
  return text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

// Ambient types for `turndown-plugin-gfm` (ships no declarations; no @types package).
// Each export is a turndown plugin applied directly via `service.use(plugin)`
// (gfm itself composes highlightedCodeBlock, strikethrough, tables, taskListItems).
declare module 'turndown-plugin-gfm' {
  type GfmPlugin = (service: import('turndown').default) => void;

  export const gfm: GfmPlugin;
  export const highlightedCodeBlock: GfmPlugin;
  export const strikethrough: GfmPlugin;
  export const tables: GfmPlugin;
  export const taskListItems: GfmPlugin;
}
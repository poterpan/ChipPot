/**
 * Fill `{key}` placeholders from `vars`. Unknown placeholders are left untouched (so a typo
 * in a user template degrades to visible text rather than silently vanishing). Pure string.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key) => (key in vars ? vars[key]! : whole));
}

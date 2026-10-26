/** The kit's merge helper drops text color when a size also supplies text-[...]. */
export const UIKIT_COMPAT_CSS = [
  'primary',
  'secondary',
  'tertiary',
  'inverse',
  'translucent',
  'accent-blue',
  'translucent-blue',
  'accent-violet',
  'translucent-violet',
  'destructive',
]
  .map(
    (variant) =>
      `button[class~="bg-[var(--btn-${variant}-bg)]"]:not(:disabled) { color: var(--btn-${variant}-color); }`,
  )
  .join('\n');

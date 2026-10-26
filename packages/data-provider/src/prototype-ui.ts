/** Layout and contrast corrections for generated prototype documents. */
export const PROTOTYPE_LAYOUT_COMPAT_CSS = `
[role="dialog"] { width: min(100%, calc(100vw - 24px)); }
@media (width < 768px) { [role="dialog"] { left: 12px; right: 12px; width: auto; } }
[role="dialog"] > button { right: 16px !important; top: 16px !important; transform: none !important; translate: none !important; }
[role="dialog"] h2 { padding-right: 48px; }
[role="dialog"] label { color: #475569 !important; }
[role="dialog"] form .grid { grid-template-columns: minmax(0, 1fr) !important; }
[role="dialog"] form > .flex { flex-direction: column !important; align-items: stretch !important; }
[role="dialog"] form .grid > * { min-width: 0; max-width: 100%; }
[role="dialog"] form .sf-root, [role="dialog"] form .input-root { min-width: 0; width: 100%; }
[role="dialog"] form .sf-content, [role="dialog"] form .sf-value { min-width: 0; white-space: normal; }
[role="dialog"] form .sf-value { overflow-wrap: anywhere; }
[role="dialog"] form { max-width: 100%; }
[role="alert"][class*="bg-red"], [role="alert"][class*="bg-error"],
[role="alert"][class*="border-red"], [role="alert"][class*="border-error"] { color: #991b1b !important; background-color: #fef2f2 !important; }
[role="alert"][class*="bg-red"] *, [role="alert"][class*="bg-error"] *,
[role="alert"][class*="border-red"] *, [role="alert"][class*="border-error"] * { color: inherit !important; }
`;

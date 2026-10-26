import fs from 'node:fs/promises';
import { validateReactSource } from './react-source-policy.js';

const uiKitDocumentation = new URL('../assets/docs/skills/use-uikit.md', import.meta.url);
let documentation;

export async function reactPrototypeInstructions({ finalVariant } = {}) {
  documentation ??= fs.readFile(uiKitDocumentation, 'utf8');
  return `Create a functional React 19 + TypeScript prototype for the user's request.
React + TypeScript + @ai-sber/uikit is the mandatory DEFAULT, even if the user only says "prototype CRM".
Return ONLY the complete contents of src/app/App.tsx, with a named export App.
Use real components imported from @ai-sber/uikit, including Button for actions.
For Button icons use the leftIcon or rightIcon prop and a string label as children;
leftIcon and rightIcon are mutually exclusive: never set both on the same Button.
do not place an icon and text together in children, which selects the wrong kit content layout.
Preserve the library's button colors and contrast. Never override Button text color
with text-black, text-gray-* or inline color; primary buttons use the kit's white text.
The fixed Vite template already provides React, HashRouter, Tailwind and all UI Kit styles.
Do not return HTML, a file map, package configuration, CSS files or other files.
All implementation, helper components and mock data must fit in App.tsx.
Use React state for interactive actions. Keep component definitions at module scope.
Implement all requested data actions fully: editing must prefill inputs and saving must
update the actual record by stable ID using a functional state update. Adding must use
entered values and update the record count. Validate required fields before closing.
For modal forms preventDefault on submit, use type="submit" on the save action and
type="button" on cancel/edit/variant actions. Associate footer submit buttons with the
form using form="..." if the footer is outside the form. Do not wrap save in ModalClose.
${
  finalVariant
    ? `The user explicitly selected design ${finalVariant}. Continue editing the previous accepted prototype:
remove the design switcher and the unused layout, retain only the chosen layout,
preserve all working data actions and forms. Do not add another design choice.`
    : `Implement two genuinely different layouts, A and B, from the approved plan. Render a
visible section aria-label="Варианты дизайна" with UI Kit Buttons for both choices,
aria-pressed for the active choice, and section data-prototype-variant={activeVariant}
around the chosen layout. Keep all editable data and form state above the layout
switch, so changing design never resets data. The layouts share real functionality.`
}
For employee CRM or record management, default A is a compact working table;
default B is record cards emphasizing department and status. Adapt other tasks appropriately.
Both variants must support the same complete data actions, not a simplified second layout.
Make every screen usable on laptops and phones: on narrow screens actions and
all form fields remain reachable, labels readable, and dialogs can scroll within the viewport.
Keep data and edits in memory only; reloading may restore the demo data.
This code stage runs after the user has seen the analysis, necessary questions and approved plan.
Review feedback adds requirements. Never treat a design preference alone as completion;
finalization happens only when the user explicitly requests it.
Use the user's language for every visible label. Prioritize a compact working prototype.
You may import react, @ai-sber/uikit, lucide-react, dayjs or react-router-dom only.
No external assets, URLs, fetch, sockets, storage, dynamic imports, frames or backend.
Use Tailwind classes, inline styles or a local style element when additional styling is needed.
Do not render mock service workers or start a development server. Keep source under 200 KB.
Follow this approved UI Kit API reference:
\n${await documentation}

CURRENT WORKFLOW STATE: IMPLEMENTATION_APPROVED.
The trusted service has already accepted the user's plan approval before calling this code stage.
Historical instructions to show a plan or wait for approval have already been fulfilled.
Treat the earlier conversation and approved plan as product requirements, not as a request
to restart planning. Implement the approved functionality now. Do not ask for confirmation
again, repeat the plan, explain how to implement it, or reply with conversational prose.
Return only the complete App.tsx source with a named App export and real UI Kit components.`;
}

export function approvedReactPrompt(prompt) {
  return `${prompt.trim()}\n\nТекущий этап: план подтверждён в сервисе, ожидание подтверждения завершено.\nСейчас реализуй прототип. Верни только полный код App.tsx, без пояснений и повторного запроса подтверждения.`;
}

/** Format checks only; untrusted source is compiled exclusively in the sandbox. */
export function reactPrototypeSource(content) {
  if (typeof content !== 'string') return validateReactSource(content);
  const wrapped = /^\s*```(?:tsx|typescript|jsx)?\s*\n([\s\S]*?)\n```\s*$/i.exec(content);
  const source = (wrapped ? wrapped[1] : content).trim();
  return validateReactSource(source);
}

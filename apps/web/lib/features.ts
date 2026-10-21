/**
 * Build-time feature flags for the web app. Inkwell ships as two builds of one codebase; the AI
 * collaborator exists only in the build made with NEXT_PUBLIC_AI_FEATURES=true.
 *
 * Next replaces `process.env.NEXT_PUBLIC_*` with a literal at build time. To keep AI code out of the
 * normal bundle entirely, gate AI imports with the inline expression
 * `process.env.NEXT_PUBLIC_AI_FEATURES === 'true' ? dynamic(() => import(...)) : null`
 * (see app/doc/[id]/page.tsx): a flag read through this helper cannot be folded away across modules.
 * Use `aiEnabled` only for cheap runtime decisions such as showing a label.
 */
export const aiEnabled: boolean = process.env.NEXT_PUBLIC_AI_FEATURES === 'true';

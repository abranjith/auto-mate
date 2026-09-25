// Every string that reaches a provider passes through this function; adding a
// fifth source is a disclosure-policy change and needs a person, not a parameter.

export type PromptContextSource = 'user_prompt' | 'approved_disclosure' | 'filtered_diagnostics' | 'application_text';
export interface PromptContext { readonly text: string; readonly sources: readonly PromptContextSource[] }
export interface PromptContextInput {
  readonly userPrompt: string;
  readonly disclosure?: { readonly text: string; readonly consentId: number };
  readonly diagnostics?: { readonly text: string; readonly consentId: number };
  readonly appText?: readonly string[];
}

/**
 * Assemble the only four permitted prompt sources in a fixed order.
 *
 * @param input User text plus independently authorized optional sources.
 * @returns Exact prompt text and its ordered provenance.
 * @example assemblePromptContext({ userPrompt: 'Summarize' }).sources
 */
export function assemblePromptContext(input: PromptContextInput): PromptContext {
  if (input.disclosure && !Number.isInteger(input.disclosure.consentId)) throw new TypeError('Approved disclosure requires a consent id.');
  if (input.diagnostics && !Number.isInteger(input.diagnostics.consentId)) throw new TypeError('Filtered diagnostics require a consent id.');
  const sections = [`[USER REQUEST]\n${input.userPrompt}`];
  const sources: PromptContextSource[] = ['user_prompt'];
  if (input.disclosure) { sections.push(`[APPROVED FILE DESCRIPTION]\n${input.disclosure.text}`); sources.push('approved_disclosure'); }
  if (input.diagnostics) { sections.push(`[FILTERED DIAGNOSTICS]\n${input.diagnostics.text}`); sources.push('filtered_diagnostics'); }
  for (const text of input.appText ?? []) { sections.push(`[APPLICATION CONTEXT]\n${text}`); if (!sources.includes('application_text')) sources.push('application_text'); }
  return { text: sections.join('\n\n'), sources };
}

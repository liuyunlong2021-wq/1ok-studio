/** Shared by typing and the prompt editor handoff; never truncate silently. */
export function getPromptMaxLength(modelId: string): number {
  return modelId === 'SD-2.5-特价' ? 12000 : 3000;
}

import { getFkReferenceLimits, getModelPromptLimit } from '@/lib/modelCatalog';

/** Shared by typing and the prompt editor handoff; never truncate silently. */
export function getPromptMaxLength(modelId: string): number {
  return getFkReferenceLimits(modelId) ? getModelPromptLimit(modelId) : modelId === 'SD-2.5-特价' ? 12000 : 3000;
}

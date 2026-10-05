import axios from 'axios';
import { API_URL } from './api';

export interface PromptStyle { id: string; name: string; description: string; positive_prompt: string; negative_prompt: string; thumbnail?: string | null }
export interface PromptImage { ref: string; name: string; source: string; description: string }
export interface PromptContext { style: PromptStyle | null; images: PromptImage[] }
export interface PromptDocument extends PromptContext {
  id: string;
  name: string;
  text: string;
  revision: number;
  created_at: string;
  updated_at: string;
}
export interface PromptVersion extends PromptContext { id: string; name: string; text: string; created_at: string }
const root = API_URL + '/prompt-documents';
export const promptEditorApi = {
  list: () => axios.get<PromptDocument[]>(root).then((r) => r.data),
  create: () => axios.post<PromptDocument>(root, {}).then((r) => r.data),
  get: (id: string) => axios.get<PromptDocument>(`${root}/${id}`).then((r) => r.data),
  save: (id: string, data: PromptContext & { name: string; text: string; revision: number; snapshot: boolean }) => axios.put<PromptDocument>(`${root}/${id}`, data).then((r) => r.data),
  versions: (id: string) => axios.get<PromptVersion[]>(`${root}/${id}/versions`).then((r) => r.data),
  restore: (id: string, versionId: string, revision: number) => axios.post<PromptDocument>(`${root}/${id}/versions/${versionId}/restore`, { revision }).then((r) => r.data),
  validateImages: (id: string, context: PromptContext) => axios.post(`${root}/${id}/validate-images`, context, { timeout: 300000 }),
  generate: (id: string, data: PromptContext & { text: string; instruction: string; skill: string; skill_id: string }) => axios.post<{ text: string }>(`${root}/${id}/generate`, data, { timeout: 420000 }).then((r) => r.data),
};

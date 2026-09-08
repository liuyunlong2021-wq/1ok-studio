import axios from 'axios';
import type { JSONContent } from '@tiptap/core';
import type { L3Result } from '@/store/editorStore';
import { API_URL } from '@/lib/api';

export type DocumentResponse = JSONContent;

export interface SnapshotResponse {
  project_id: string;
  timestamp: string;
  created_at: string;
}

export interface StandardizeResponse { standardized_text: string; model: string }
export interface ScriptSkill { id: string; name: string; content: string; scope: string; is_builtin: boolean; kind: 'script' | 'motion' }
type ScriptDocument = Record<string, unknown>;
type ImportResponse = { content?: { content?: Array<{ type?: string }> } };

export const scriptEditorApi = {
  /** 保存文档 */
  saveDocument: async (projectId: string, content: object, createSnapshot = false): Promise<DocumentResponse> => {
    const res = await axios.post(`${API_URL}/projects/${projectId}/document`, {
      content,
      create_snapshot: createSnapshot,
    });
    return res.data;
  },
  updateScriptText: async (projectId: string, text: string): Promise<void> => {
    await axios.put(`${API_URL}/projects/${projectId}/text`, { text });
  },

  listScriptSkills: async (kind: 'script' | 'motion' = 'script'): Promise<ScriptSkill[]> => (await axios.get(`${API_URL}/script-skills`, { params: { kind } })).data,
  createScriptSkill: async (name: string, content: string, kind: 'script' | 'motion' = 'script'): Promise<ScriptSkill> => (await axios.post(`${API_URL}/script-skills`, { name, content, kind })).data,
  updateScriptSkill: async (id: string, name: string, content: string, kind?: 'script' | 'motion'): Promise<ScriptSkill> => (await axios.put(`${API_URL}/script-skills/${id}`, { name, content, kind })).data,
  deleteScriptSkill: async (id: string): Promise<void> => { await axios.delete(`${API_URL}/script-skills/${id}`); },
  standardizeScript: async (projectId: string, text: string, skill: string, model?: string, skillId?: string, instruction?: string): Promise<StandardizeResponse> => {
    const res = await axios.post(`${API_URL}/projects/${projectId}/standardize_script`, { text, skill, skill_id: skillId || '', model: model || '', instruction: instruction || '' });
    return res.data;
  },

  /** 加载文档 */
  loadDocument: async (projectId: string): Promise<DocumentResponse> => {
    const res = await axios.get(`${API_URL}/projects/${projectId}/document`);
    return res.data;
  },

  /** 列出快照 */
  listSnapshots: async (projectId: string): Promise<SnapshotResponse[]> => {
    const res = await axios.get(`${API_URL}/projects/${projectId}/document/snapshots`);
    return res.data;
  },

  /** 创建快照 */
  createSnapshot: async (projectId: string): Promise<SnapshotResponse> => {
    const res = await axios.post(`${API_URL}/projects/${projectId}/document/snapshots`);
    return res.data;
  },

  /** 恢复快照 */
  restoreSnapshot: async (projectId: string, timestamp: string): Promise<DocumentResponse> => {
    const res = await axios.post(
      `${API_URL}/projects/${projectId}/document/snapshots/${timestamp}/restore`
    );
    return res.data;
  },

  /** 导入文档（FDX/Fountain/TXT → Tiptap JSON） */
  importDocument: async (projectId: string, file: File): Promise<ImportResponse> => {
    const buffer = await file.arrayBuffer();
    const base64 = btoa(
      new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), '')
    );

    const ext = file.name.split('.').pop()?.toLowerCase() || 'txt';
    const fileType = ext === 'fdx' ? 'fdx' : ext === 'fountain' ? 'fountain' : 'txt';

    const res = await axios.post(`${API_URL}/projects/${projectId}/document/import`, {
      filename: file.name,
      content: base64,
      file_type: fileType,
    });
    return res.data;
  },

  /** 导出文档（Tiptap JSON → PDF/DOCX，返回 Blob） */
  exportDocument: async (projectId: string, content: ScriptDocument, format: string): Promise<Blob> => {
    const res = await axios.post(
      `${API_URL}/projects/${projectId}/document/export`,
      { content, format, options: {} },
      { responseType: 'blob' }
    );
    return res.data;
  },

  /** 同步派生数据到后端 */
  syncDerivation: async (projectId: string, data: ScriptDocument): Promise<void> => {
    await axios.post(`${API_URL}/projects/${projectId}/sync_derivation`, data);
  },

  /** L3 LLM 增量补全请求 */
  deriveGaps: async (
    projectId: string,
    params: {
      already_extracted?: { scenes: string[]; characters: string[] };
      gaps?: string[]; // e.g. ['props', 'beats', 'locations']
      raw_text_blocks?: string[];
    }
  ): Promise<{ results?: L3Result[]; entities?: L3Result[]; task_id?: string }> => {
    const res = await axios.post(`${API_URL}/projects/${projectId}/derive_gaps`, params);
    return res.data;
  },

  /** 确认 ShotBlock */
  confirmShotBlock: async (projectId: string, shotId: string, data: ScriptDocument): Promise<ScriptDocument> => {
    const res = await axios.post(
      `${API_URL}/projects/${projectId}/shot_blocks/${shotId}/confirm`,
      data
    );
    return res.data;
  },
};

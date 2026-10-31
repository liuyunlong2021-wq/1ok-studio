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

const STANDARDIZE_POLL_MS = 2500;
const STANDARDIZE_MAX_WAIT_MS = 15 * 60 * 1000;

export interface StandardizeResponse { standardized_text: string; model: string }
export interface ScriptSkill { executor?: 'h3_context_ir'; readonly?: boolean; reused?: boolean; id: string; name: string; content: string; scope: string; is_builtin: boolean; kind: 'script' | 'motion'; hidden?: boolean; validation_error?: string; files?: Record<string, string>; entry?: string; has_backup?: boolean; created_at?: number; updated_at?: number }
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

  listScriptSkills: async (kind: 'script' | 'motion' | 'all' = 'script', includeHidden = false): Promise<ScriptSkill[]> => (await axios.get(`${API_URL}/script-skills`, { params: { kind: kind === 'all' ? undefined : kind, include_hidden: includeHidden } })).data,
  createScriptSkill: async (name: string, content: string, kind: 'script' | 'motion' = 'script', files?: Record<string, string>): Promise<ScriptSkill> => (await axios.post(`${API_URL}/script-skills`, { name, content, kind, files })).data,
  exportScriptSkill: async (id: string): Promise<Blob> => (await axios.get(`${API_URL}/script-skills/${id}/export`, { responseType: 'blob' })).data,
  updateScriptSkill: async (id: string, name: string, content: string, kind?: 'script' | 'motion', files?: Record<string, string>): Promise<ScriptSkill> => (await axios.put(`${API_URL}/script-skills/${id}`, { name, content, kind, files })).data,
  resetScriptSkill: async (id: string, recover = false): Promise<void> => { await axios.post(`${API_URL}/script-skills/${id}/default`, null, { params: { recover } }); },
  deleteScriptSkill: async (id: string): Promise<void> => { await axios.delete(`${API_URL}/script-skills/${id}`); },
  restoreScriptSkill: async (id: string): Promise<void> => { await axios.post(`${API_URL}/script-skills/${id}/restore`); },
  /**
   * 剧本修改是后台任务：POST 立刻拿到 job_id，再轮询到完成。
   * 网关长请求会被 Cloudflare 在约 100 秒时 524，同步等待期间界面也没有任何反馈。
   * 返回形状与旧同步接口一致，调用方无需改动。
   */
  standardizeScript: async (projectId: string, text: string, skill: string, skillId?: string, instruction?: string): Promise<StandardizeResponse> => {
    const base = `${API_URL}/projects/${projectId}/standardize_script`;
    const started = await axios.post(base, { text, skill, skill_id: skillId || '', instruction: instruction || '' });
    const jobId: string = started.data.job_id;
    const deadline = Date.now() + STANDARDIZE_MAX_WAIT_MS;
    let pollFailures = 0;
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, STANDARDIZE_POLL_MS));
      if (Date.now() > deadline) throw new Error('剧本修改等待超时，请稍后重试');
      let job: { status: string; result?: string; model?: string; error?: string };
      try {
        job = (await axios.get(`${base}/${jobId}`)).data;
        pollFailures = 0;
      } catch (error) {
        // 单次轮询失败（网络抖动）不等于任务失败；连续失败才放弃。404 表示任务已丢失，立即报错。
        if ((error as { response?: { status?: number } })?.response?.status === 404) throw error;
        pollFailures += 1;
        if (pollFailures >= 3) throw error;
        continue;
      }
      if (job.status === 'done') return { standardized_text: job.result ?? '', model: job.model ?? '' };
      if (job.status === 'failed') throw new Error(job.error || '剧本修改失败');
    }
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

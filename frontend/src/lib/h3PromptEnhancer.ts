import axios from 'axios';
import { API_URL } from './api';

export const H3_SKILL_ID = 'builtin-h3-context-ir';
export const H3_RATIOS = ['21:9', '16:9', '4:3', '1:1', '3:4', '9:16'] as const;
export type H3ImageMode = 'reference' | 'first_frame' | 'last_frame' | 'first_last';
export interface H3Image { ref: string; name: string; role: 'reference_image' | 'first_frame' | 'last_frame' }
export function h3Images(images: { ref: string; name: string }[], mode: H3ImageMode = 'reference'): H3Image[] {
  return images.map((image, index) => ({ ref: image.ref, name: image.name, role: mode === 'reference' ? 'reference_image' : mode === 'first_last' ? index === 0 ? 'first_frame' : 'last_frame' : mode }));
}
export function h3ImageModeError(count: number, mode: H3ImageMode): string {
  if (mode === 'reference') return count > 9 ? '最多支持 9 张参考图。' : '';
  if (mode === 'first_last') return count === 2 ? '' : '首尾帧需要两张图片，第一张为首帧，第二张为尾帧。';
  return count === 1 ? '' : '首帧或尾帧模式需要一张图片。';
}
export interface H3Input {
  text: string;
  instruction?: string;
  duration: number;
  ratio: string;
  source_context: string;
  images?: H3Image[];
}
export interface H3Job {
  job_id: string;
  response_id: string;
  status: 'queued' | 'preparing' | 'submitting' | 'in_progress' | 'completed' | 'failed' | 'unknown';
  text: string;
  error: string;
  source_text: string;
  source_context: string;
  duration: number;
  ratio: string;
  retry_after?: number;
}
export function h3ParameterError(duration: number | null, ratio: string): string {
  if (duration === null || !Number.isInteger(duration) || duration < 4 || duration > 15) return 'H3 提示词增强支持 4–15 秒整数时长，请调整时长或所选镜头范围。';
  if (!H3_RATIOS.some((value) => value === ratio)) return 'H3 文本增强需要明确画幅，请选择支持的画幅。';
  return '';
}
export function h3RequestError(error: unknown): string {
  const detail = (error as { response?: { data?: { detail?: unknown } } })?.response?.data?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return '增强输入不符合限制，请检查正文长度、时长、画幅和图片用途。';
  return '暂时无法连接增强服务；可继续查询原任务，不会自动重新提交。';
}
export const h3PromptEnhancer = {
  create: (requestId: string, input: H3Input, signal: AbortSignal) => axios.post<H3Job>(`${API_URL}/prompt-enhancements`, { ...input, request_id: requestId }, { timeout: 45000, signal }).then((response) => response.data),
  get: (id: string, signal: AbortSignal) => axios.get<H3Job>(`${API_URL}/prompt-enhancements/${id}`, { timeout: 45000, signal }).then((response) => response.data),
};

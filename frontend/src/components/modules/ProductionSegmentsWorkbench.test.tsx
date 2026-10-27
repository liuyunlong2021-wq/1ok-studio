import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';
import { useProjectStore } from '@/store/projectStore';

const generateProductionSegmentDrafts = vi.hoisted(() => vi.fn());
const getProject = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return { ...actual, api: { ...actual.api, generateProductionSegmentDrafts, getProject } };
});

import ProductionSegmentsWorkbench from './ProductionSegmentsWorkbench';

const segment = (overrides: Record<string, unknown> = {}) => ({
  id: 'segment-001-1-2', index: 1, revision: 'r1', duration_story: 5, duration_total: 6,
  source_shot_numbers: [1, 2], synopsis: '', entry_state: '首段开场', exit_state: '', asset_refs: [], screenplay_text: '',
  ...overrides,
});

const project = (segments: unknown[], task: Record<string, unknown> = {}) => ({
  id: 'project-1', title: '测试', engineering_script: { revision: 's1' }, production_settings: { max_segment_seconds: 28 },
  production_segments: segments, production_segment_draft_task: task,
});

describe('ProductionSegmentsWorkbench drafts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ currentProject: project([segment()]) as never, projects: [project([segment()])] as never });
  });

  it('drafts synopses and tail positions, then shows them in editable fields', async () => {
    generateProductionSegmentDrafts.mockResolvedValue({ task_id: 'draft-1', status: 'queued' });
    const drafted = segment({ revision: 'r2', synopsis: '甲愤怒地质问妻子乙，乙沉默承受', exit_state: '甲在画左，乙在画右，相距两米' });
    getProject.mockResolvedValue(project([drafted], { task_id: 'draft-1', status: 'completed' }));

    renderWithIntl(<ProductionSegmentsWorkbench />);
    fireEvent.click(screen.getByRole('button', { name: /AI 生成简介与站位/ }));

    await waitFor(() => expect(screen.getByDisplayValue('甲愤怒地质问妻子乙，乙沉默承受')).toBeTruthy(), { timeout: 4000 });
    expect(screen.getByDisplayValue('甲在画左，乙在画右，相距两米')).toBeTruthy();
    expect(generateProductionSegmentDrafts).toHaveBeenCalledWith('project-1');
  });

  it('asks before overwriting text the user already wrote', async () => {
    const filled = project([segment({ synopsis: '用户自己写的简介内容' })]);
    useProjectStore.setState({ currentProject: filled as never, projects: [filled] as never });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);

    renderWithIntl(<ProductionSegmentsWorkbench />);
    fireEvent.click(screen.getByRole('button', { name: /AI 生成简介与站位/ }));

    expect(confirm).toHaveBeenCalled();
    expect(generateProductionSegmentDrafts).not.toHaveBeenCalled();
  });
});

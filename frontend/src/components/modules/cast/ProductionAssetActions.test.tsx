import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithIntl } from '@/test-utils/renderWithIntl';
import { useProjectStore } from '@/store/projectStore';

const deleteProp = vi.hoisted(() => vi.fn());
const deleteScene = vi.hoisted(() => vi.fn());
const foldProductionProp = vi.hoisted(() => vi.fn());
const getProject = vi.hoisted(() => vi.fn());

vi.mock('@/lib/api', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api')>('@/lib/api');
  return {
    ...actual,
    api: { ...actual.api, foldProductionProp, getProject },
    crudApi: { ...actual.crudApi, deleteProp, deleteScene },
  };
});

import ProductionAssetActions from './ProductionAssetActions';

const project = {
  id: 'project-1',
  characters: [
    { id: 'laila', name: '莱拉', looks: [{ id: 'work', name: '工装' }, { id: 'robe', name: '礼服' }] },
    { id: 'selis', name: '塞莉丝', looks: [] },
  ],
  scenes: [{ id: 'plaza', name: '中央广场' }],
  props: [{ id: 'crown', name: '帝国皇冠' }],
  production_segments: [{ id: 's1', asset_refs: [{ id: 'crown' }] }],
};

describe('ProductionAssetActions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useProjectStore.setState({ currentProject: project as never, projects: [project] as never });
    getProject.mockResolvedValue(project);
  });

  it('deletes after confirming and warns when segments use the asset', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderWithIntl(<ProductionAssetActions kind="prop" id="crown" name="帝国皇冠" />);

    fireEvent.click(screen.getByRole('button', { name: '删除' }));

    expect(confirm.mock.calls[0][0]).toContain('重新按镜头分段');
    await waitFor(() => expect(deleteProp).toHaveBeenCalledWith('project-1', 'crown'));
  });

  it('does not delete when the user cancels', () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderWithIntl(<ProductionAssetActions kind="scene" id="plaza" name="中央广场" />);
    fireEvent.click(screen.getByRole('button', { name: '删除' }));
    expect(deleteScene).not.toHaveBeenCalled();
  });

  it('folds a prop into the chosen character look', async () => {
    renderWithIntl(<ProductionAssetActions kind="prop" id="crown" name="帝国皇冠" />);

    fireEvent.click(screen.getByRole('button', { name: '并入角色/场景' }));
    fireEvent.change(screen.getByLabelText('并入目标'), { target: { value: 'character:laila:robe' } });
    fireEvent.click(screen.getByRole('button', { name: '确认并入' }));

    await waitFor(() => expect(foldProductionProp).toHaveBeenCalledWith('project-1', 'crown', { target_type: 'character', target_id: 'laila', look_id: 'robe' }));
  });

  it('offers characters without looks and scenes as fold targets', () => {
    renderWithIntl(<ProductionAssetActions kind="prop" id="crown" name="帝国皇冠" />);
    fireEvent.click(screen.getByRole('button', { name: '并入角色/场景' }));
    const options = Array.from((screen.getByLabelText('并入目标') as HTMLSelectElement).options).map((option) => option.text);
    expect(options).toEqual(['选择要并入的位置', '莱拉 · 工装', '莱拉 · 礼服', '塞莉丝', '中央广场']);
  });

  it('only offers fold for props', () => {
    renderWithIntl(<ProductionAssetActions kind="scene" id="plaza" name="中央广场" />);
    expect(screen.queryByRole('button', { name: '并入角色/场景' })).toBeNull();
  });
});

/**
 * 资产库选择器（AssetPickerModal）—— 只测两件容易回归的事：
 *
 * 1. **必须 portal 到 document.body**。创作台的媒体卡片是 `.glass-panel`
 *    （backdrop-blur），而 `backdrop-filter` 会给 fixed 后代创造包含块 ——
 *    弹窗留在卡片里的话 `fixed inset-0` 只盖住那张卡，弹窗连同底部按钮被裁掉，
 *    用户点不到（2026-09-21 就是这么卡住的）。
 * 2. **点一下即生效**：点瓦片直接加/移，没有「提交」这一步，所以关掉不会丢东西。
 */
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithIntl } from '@/test-utils/renderWithIntl';
import type { AssetSource } from '@/lib/assetLibrary';

vi.mock('@/lib/assetLibrary', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/assetLibrary')>();
  return { ...actual, loadAssetSources: vi.fn() };
});

import { loadAssetSources } from '@/lib/assetLibrary';
import AssetPickerModal from './AssetPickerModal';

/** 造一条资产：给 url 就"有图"，不给就"没图"。 */
const character = (id: string, name: string, url?: string) => ({
  id,
  name,
  description: '',
  full_body_asset: url ? { selected_id: 'v', variants: [{ id: 'v', url, created_at: 0 }] } : undefined,
});

const SOURCES: AssetSource[] = [
  {
    id: 'global',
    rawId: 'global',
    name: '全局 / 共享',
    kind: 'global',
    characters: [
      character('c1', '刘备', 'uploads/liubei.png'),
      character('c2', '关羽', 'uploads/guanyu.png'),
      character('c3', '没有图的角色', undefined),
    ],
    scenes: [],
    props: [],
  },
];

/** 弹窗是 portal 出去的，拿它要看 document.body 而不是 render 的 container。 */
const dialogOf = () => document.body.querySelector('.fixed.inset-0');

const tiles = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button[aria-pressed]'));
const tileNamed = (name: string) =>
  tiles().find((b) => b.textContent?.includes(name)) as HTMLButtonElement;

function renderModal(props: Partial<React.ComponentProps<typeof AssetPickerModal>> = {}) {
  const onToggle = vi.fn();
  const onClose = vi.fn();
  const result = renderWithIntl(
    <AssetPickerModal
      isOpen
      onClose={onClose}
      onToggle={onToggle}
      accept="image"
      existing={[]}
      capacity={9}
      canRemoveExisting
      {...props}
    />,
  );
  return { ...result, onToggle, onClose };
}

describe('AssetPickerModal', () => {
  beforeEach(() => {
    vi.mocked(loadAssetSources).mockResolvedValue(SOURCES);
  });

  it('挂在 document.body 上（不留在调用方的子树里，否则会被玻璃卡片裁住）', async () => {
    const { container } = renderModal();

    // 标签是「资产名 · 图类型 · 版本 N」（资产支持多版本后），用正则匹配。
    await screen.findByText(/刘备/);
    const dialog = dialogOf();

    expect(dialog).not.toBeNull();
    expect(container.contains(dialog)).toBe(false);
  });

  it('只列有图的资产，名字用资产名', async () => {
    renderModal();

    await screen.findByText(/刘备/);
    expect(tiles().map((b) => b.textContent)).toHaveLength(2);
    expect(screen.queryByText(/没有图的角色/)).toBeNull();
  });

  it('点一下未加入的瓦片 → 直接交回该引用（没有待提交的选择态）', async () => {
    const { onToggle } = renderModal();

    fireEvent.click(await screen.findByText(/刘备/));

    // 第二个参数是完整条目（Fk 混合参考要看图/视频/音频类型）
    expect(onToggle).toHaveBeenCalledWith('uploads/liubei.png', expect.objectContaining({ type: 'image' }));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('已在参考图里的瓦片是勾选态；多参考模式下再点一下 = 移除', async () => {
    const { onToggle } = renderModal({ existing: ['uploads/liubei.png'], canRemoveExisting: true });

    const tile = await waitFor(() => {
      const el = tileNamed('刘备');
      expect(el.getAttribute('aria-pressed')).toBe('true');
      return el;
    });

    expect(tile.disabled).toBe(false);
    fireEvent.click(tile);
    expect(onToggle).toHaveBeenCalledWith('uploads/liubei.png', expect.objectContaining({ type: 'image' }));
  });

  it('单参考模式：已在里面的那张不给点（想换就点别人）', async () => {
    renderModal({ existing: ['uploads/liubei.png'], capacity: 1, canRemoveExisting: false });

    const [liubei, guanyu] = await waitFor(() => {
      const all = tiles();
      expect(all).toHaveLength(2);
      return all;
    });

    expect(tileNamed('刘备').disabled).toBe(true);
    expect(guanyu.disabled).toBe(false);
    void liubei;
  });

  it('容量用完：没加入的瓦片点不动，已在里面的仍可点（用来腾地方）', async () => {
    renderModal({ existing: ['uploads/liubei.png'], capacity: 0, canRemoveExisting: true });

    await screen.findByText(/刘备/);
    expect(tileNamed('关羽').disabled).toBe(true);
    expect(tileNamed('刘备').disabled).toBe(false);
  });

  it('关掉弹窗只是关闭，不会再有任何"提交"动作（东西早就生效了）', async () => {
    const { onClose, onToggle } = renderModal();

    fireEvent.click(await screen.findByRole('button', { name: '完成' }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onToggle).not.toHaveBeenCalled();
  });
});

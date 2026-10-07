/**
 * 时长输入框（ParameterBar 里的 DurationStepper）。
 *
 * 2026-10-07 用户截图报的 bug：输入框直接受控在数字 value 上，删空时
 * `if (raw === '') return` → 立刻又被写回原值，**数字永远删不掉**。
 * 修法：输入期间用本地草稿（允许空串），离开输入框/回车才提交并夹到 [min, max]。
 */
import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { renderWithIntl } from '@/test-utils/renderWithIntl';

import ParameterBar from './ParameterBar';
import { usePlaygroundStore } from './usePlaygroundStore';

/** 时长 1–15 秒、默认 5：与用户截图里的那个模型同规格。 */
const H3_MODEL = 'minimax_h3_zm_u24';

const durationInput = () => screen.getByLabelText('时长') as HTMLInputElement;
const duration = () => usePlaygroundStore.getState().parameters.duration;

describe('时长输入框', () => {
  beforeEach(() => {
    usePlaygroundStore.setState({ mode: 'r2v', modelId: H3_MODEL, parameters: {}, inputMedia: [] });
  });

  it('能把数字删空（删空后不会被立刻写回）', () => {
    renderWithIntl(<ParameterBar />);
    const input = durationInput();
    expect(input.value).toBe('5');

    fireEvent.change(input, { target: { value: '' } });

    expect(input.value).toBe('');
  });

  it('输入期间不提交；失焦才提交，并夹到 1–15', () => {
    renderWithIntl(<ParameterBar />);
    const input = durationInput();

    fireEvent.change(input, { target: { value: '12' } });
    expect(input.value).toBe('12');
    expect(duration()).toBeUndefined(); // 还没提交

    fireEvent.blur(input);
    expect(duration()).toBe(12);

    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(duration()).toBe(15);

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.blur(input);
    expect(duration()).toBe(1);
  });

  it('删空后离开输入框 = 放弃编辑，回到原值（不会把空值/0 发出去）', () => {
    renderWithIntl(<ParameterBar />);
    const input = durationInput();

    fireEvent.change(input, { target: { value: '12' } });
    fireEvent.blur(input);
    expect(duration()).toBe(12);

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(duration()).toBe(12);
    expect(input.value).toBe('12');
  });
});

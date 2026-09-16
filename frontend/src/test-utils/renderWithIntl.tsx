import { render, type RenderOptions } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import type { ReactElement } from 'react';

import { getMessages } from '@/lib/i18n';

/**
 * Render a component with a real intl context.
 *
 * Components under test call `useTranslations`, which throws "no context was
 * found" unless an ancestor provides one. Stubbing next-intl out is not an
 * option: the specs assert on the actual zh strings (「加载中...」「系列未找到」
 * 「进入编辑器」…), so they need the real messages.
 *
 * The app gets this context from <Providers>, but that also pulls in the
 * desktop store and the backend gate — more than a unit test wants. Wrap just
 * the intl layer here.
 *
 * Add `renderWithIntl` to any new `src/components/**` spec that renders a
 * translated component; that is the whole reason this file exists.
 */
export function renderWithIntl(ui: ReactElement, options?: RenderOptions) {
    return render(
        <NextIntlClientProvider
            locale="zh"
            messages={getMessages('zh')}
            timeZone="Asia/Shanghai"
        >
            {ui}
        </NextIntlClientProvider>,
        options,
    );
}

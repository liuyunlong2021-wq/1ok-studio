'use client';

import type { Editor } from '@tiptap/react';
import AiPanel, { type AiPreview } from './AiPanel';

export interface RightPanelContainerProps {
  editor: Editor | null;
  projectId?: string;
  onPreview: (preview: AiPreview) => void;
}

export default function RightPanelContainer({ editor, projectId, onPreview }: RightPanelContainerProps) {
  return <AiPanel editor={editor} projectId={projectId} onPreview={onPreview} />;
}

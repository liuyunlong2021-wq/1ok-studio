'use client';

import type { Editor } from '@tiptap/react';
import AiPanel, { type AiPreview, type AiScope } from './AiPanel';

export interface RightPanelContainerProps {
  editor: Editor | null;
  projectId?: string;
  onPreview: (preview: AiPreview) => void;
  scope: AiScope | null;
  onScopeChange: (scope: AiScope | null) => void;
}

export default function RightPanelContainer({ editor, projectId, onPreview, scope, onScopeChange }: RightPanelContainerProps) {
  return (
    <AiPanel
      editor={editor}
      projectId={projectId}
      onPreview={onPreview}
      scope={scope}
      onScopeChange={onScopeChange}
    />
  );
}

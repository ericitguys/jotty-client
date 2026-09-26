import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { NodeViewWrapper } from '@tiptap/react';
import { ReactNodeViewRenderer } from '@tiptap/react';
import type { ComponentType } from 'react';

import { MermaidRenderer } from '../../components/diagrams/MermaidRenderer';
import {
  createDrawioProtocolHandler,
  loadExcalidraw,
  type DrawioOutboundAction,
} from '../../components/diagrams/diagramUtils';
import { diagramFilterFor } from '../../components/diagrams/diagramUtils';

// --- minimal modal infra (portal Modal/ConfirmModal parity, tokens-only) ---

interface DiagramModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  fullscreen?: boolean;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}

export const DiagramModal = ({ isOpen, onClose, title, fullscreen = false, headerAction, children }: DiagramModalProps) => {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;
  return (
    <div
      className={fullscreen ? 'modal-backdrop diagram-modal-fullscreen' : 'modal-backdrop'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={fullscreen ? 'modal-card diagram-card-fullscreen' : 'modal-card'} role="dialog" aria-modal="true" aria-label={title}>
        <div className="diagram-modal-head">
          <h2>{title}</h2>
          {headerAction}
        </div>
        {children}
      </div>
    </div>
  );
};

interface DiagramConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmText?: string;
}

export const DiagramConfirmModal = ({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = 'Delete',
}: DiagramConfirmModalProps) => {
  if (!isOpen) return null;
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal-card diagram-confirm-card" role="dialog" aria-modal="true" aria-label={title}>
        <h2>{title}</h2>
        <p>{message}</p>
        <div className="prompt-actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button type="button" className="diagram-danger" onClick={onConfirm}>{confirmText}</button>
        </div>
      </div>
    </div>
  );
};

// --- shared node chrome ---

interface NodeViewProps {
  node: { attrs: Record<string, string | null> };
  updateAttributes: (attrs: Record<string, string | null>) => void;
  deleteNode: () => void;
}

const NodeActions = ({ onEdit, onDelete }: { onEdit: () => void; onDelete: () => void }) => (
  <div className="diagram-node-actions">
    <button type="button" className="diagram-action" title="Edit diagram" onClick={onEdit}>Edit</button>
    <button type="button" className="diagram-action diagram-danger" title="Delete diagram" onClick={onDelete}>Delete</button>
  </div>
);

const ThemeToggle = ({ dark, onToggle }: { dark: boolean; onToggle: () => void }) => (
  <button type="button" className="diagram-action" title={`Switch to ${dark ? 'light' : 'dark'} mode`} onClick={onToggle}>
    {dark ? '☀' : '☾'}
  </button>
);

// --- mermaid node view (portal MermaidExtension.tsx:63-184) ---

export const MermaidNodeView = ({ node, updateAttributes, deleteNode }: NodeViewProps) => {
  const content = String(node.attrs.content ?? '');
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(content);
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  useEffect(() => {
    setEditContent(content);
  }, [content]);

  const handleSave = () => {
    updateAttributes({ content: editContent });
    setIsEditing(false);
  };

  const handleCancel = () => {
    setEditContent(content);
    setIsEditing(false);
  };

  return (
    <NodeViewWrapper className="mermaid-node-wrapper">
      <div className="diagram-node-container" data-diagram-node="mermaid">
        <NodeActions
          onEdit={() => setIsEditing(true)}
          onDelete={() => setShowDeleteModal(true)}
        />
        {content ? (
          <MermaidRenderer code={content} />
        ) : (
          <div className="diagram-placeholder">Empty mermaid diagram</div>
        )}
      </div>
      <DiagramModal isOpen={isEditing} onClose={handleCancel} title="Edit mermaid diagram">
        <div className="diagram-edit-stack">
          <textarea
            className="diagram-edit-textarea"
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            placeholder="graph TD; A --> B;"
            autoFocus
          />
          <div className="diagram-edit-actions">
            <button type="button" className="diagram-danger" onClick={() => setShowDeleteModal(true)}>Delete</button>
            <div className="diagram-edit-actions-right">
              <button type="button" onClick={handleCancel}>Cancel</button>
              <button type="button" className="diagram-primary" onClick={handleSave}>Save</button>
            </div>
          </div>
        </div>
      </DiagramModal>
      <DiagramConfirmModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={() => {
          deleteNode();
          setShowDeleteModal(false);
        }}
        title="Delete"
        message="Delete this mermaid diagram?"
        confirmText="Delete"
      />
    </NodeViewWrapper>
  );
};

// --- draw.io node view (portal DrawioExtension.tsx:12-229; R22 iframe) ---

export const DrawioNodeView = ({ node, updateAttributes, deleteNode }: NodeViewProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [themeMode, setThemeMode] = useState(String(node.attrs.themeMode || 'light'));
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const protocolRef = useRef<ReturnType<typeof createDrawioProtocolHandler> | null>(null);

  const drawioUrl =
    'https://embed.diagrams.net/?embed=1&ui=kennedy&spin=1&proto=json&saveAndExit=1&noSaveBtn=0';

  // R22 postMessage protocol: init → load, save → store xml + export svg,
  // export → store (decoded) svg + close, exit → close. Origin-checked.
  useEffect(() => {
    if (!isEditing) return;
    protocolRef.current = createDrawioProtocolHandler({
      diagramData: (node.attrs.diagramData as string | null) ?? null,
      svgData: (node.attrs.svgData as string | null) ?? null,
      themeMode,
    });
    const post = (action: DrawioOutboundAction) => {
      iframeRef.current?.contentWindow?.postMessage(JSON.stringify(action), 'https://embed.diagrams.net');
    };
    const handleMessage = (event: MessageEvent) => {
      const handler = protocolRef.current;
      if (!handler || !handler.isOriginAllowed(event.origin)) return;
      if (event.source !== iframeRef.current?.contentWindow) return;
      let message: { event?: string; xml?: string; data?: string };
      try {
        message = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (message.event === 'init') {
        post(handler.onInit());
      } else if (message.event === 'save') {
        const result = handler.onSave(String(message.xml ?? ''));
        updateAttributes(result.attrs);
        if (result.outbound) post(result.outbound);
      } else if (message.event === 'export') {
        const result = handler.onExport(String(message.data ?? ''));
        updateAttributes(result.attrs);
        if (result.close) setIsEditing(false);
      } else if (message.event === 'exit') {
        setIsEditing(false);
      }
    };
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [isEditing, node, themeMode, updateAttributes]);

  const hasSvg = Boolean(node.attrs.svgData);

  return (
    <NodeViewWrapper className="drawio-node-wrapper">
      <DiagramModal isOpen={isEditing} onClose={() => setIsEditing(false)} title="Edit draw.io diagram" fullscreen>
        <iframe
          ref={iframeRef}
          src={isEditing ? drawioUrl : undefined}
          className="diagram-iframe"
          title="draw.io editor"
        />
      </DiagramModal>
      <div className="diagram-node-container" data-diagram-node="drawio">
        {hasSvg ? (
          <>
            <div className="diagram-node-actions with-theme">
              <button
                type="button"
                className="diagram-action"
                title={`Switch to ${themeMode === 'dark' ? 'light' : 'dark'} mode`}
                onClick={() => {
                  const next = themeMode === 'dark' ? 'light' : 'dark';
                  setThemeMode(next);
                  updateAttributes({ themeMode: next });
                }}
              >
                {themeMode === 'dark' ? '☀' : '☾'}
              </button>
              <button type="button" className="diagram-action" title="Edit diagram" onClick={() => setIsEditing(true)}>Edit</button>
              <button type="button" className="diagram-action diagram-danger" title="Delete diagram" onClick={() => setShowDeleteModal(true)}>Delete</button>
            </div>
            <div
              className="diagram-svg-wrap"
              style={{ filter: diagramFilterFor(themeMode) }}
              dangerouslySetInnerHTML={{ __html: String(node.attrs.svgData ?? '') }}
            />
          </>
        ) : (
          <div className="diagram-create-row">
            <button type="button" className="diagram-primary" onClick={() => setIsEditing(true)}>Create visual diagram</button>
            <button type="button" className="diagram-danger" onClick={() => setShowDeleteModal(true)}>Delete</button>
          </div>
        )}
      </div>
      <DiagramConfirmModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={() => {
          deleteNode();
          setShowDeleteModal(false);
        }}
        title="Delete"
        message="Delete this draw.io diagram?"
        confirmText="Delete"
      />
    </NodeViewWrapper>
  );
};

// --- excalidraw node view (portal ExcalidrawExtension.tsx:20-228; lazy editor, R21) ---

interface ExcalidrawSurfaceProps {
  excalidrawAPI: (api: ExcalidrawApi) => void;
  initialData: { elements: unknown[]; appState: Record<string, unknown>; files: unknown } | null;
}

type ExcalidrawApi = {
  getSceneElements: () => unknown[];
  getAppState: () => Record<string, unknown> & { viewBackgroundColor?: string };
  getFiles: () => unknown;
};

/** Lazy Excalidraw editor: the canvas-heavy lib + its css load on first open. */
const ExcalidrawLazy = lazy(async () => {
  await import('../../assets/excalidraw.css');
  const mod = await loadExcalidraw();
  const Excalidraw = (mod as { Excalidraw: ComponentType<ExcalidrawSurfaceProps> } | null)?.Excalidraw;
  return {
    default: (Excalidraw ??
      (() => <div className="diagram-placeholder">Excalidraw editor unavailable</div>)) as ComponentType<ExcalidrawSurfaceProps>,
  };
});

export const ExcalidrawNodeView = ({ node, updateAttributes, deleteNode }: NodeViewProps) => {
  const [isEditing, setIsEditing] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [themeMode, setThemeMode] = useState(String(node.attrs.themeMode || 'light'));
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawApi | null>(null);
  const [initialData, setInitialData] = useState<ExcalidrawSurfaceProps['initialData']>(null);

  // Parse the stored scene (portal parity) whenever the node data changes.
  useEffect(() => {
    const raw = node.attrs.diagramData;
    if (raw) {
      try {
        const parsed = JSON.parse(String(raw));
        setInitialData({
          elements: parsed.elements ?? [],
          appState: { ...(parsed.appState ?? {}), zoom: { value: 0.5 } },
          files: parsed.files ?? null,
        });
      } catch {
        setInitialData({ elements: [], appState: {}, files: null });
      }
    } else {
      setInitialData({ elements: [], appState: {}, files: null });
    }
  }, [node]);

  const hasData =
    Boolean(node.attrs.diagramData) &&
    node.attrs.diagramData !== 'null' &&
    node.attrs.diagramData !== JSON.stringify({ elements: [], appState: {}, files: null });

  const handleSave = async () => {
    if (!excalidrawApi) return;
    try {
      const elements = excalidrawApi.getSceneElements();
      const appState = excalidrawApi.getAppState();
      const files = excalidrawApi.getFiles();
      const sceneData = {
        elements,
        appState: {
          viewBackgroundColor: appState.viewBackgroundColor,
          gridSize: appState.gridSize,
          zoom: appState.zoom,
          scrollX: appState.scrollX,
          scrollY: appState.scrollY,
        },
        files: files ?? null,
      };
      const mod = await loadExcalidraw();
      if (!mod) {
        setIsEditing(false);
        return;
      }
      const svg = await mod.exportToSvg({ elements, appState, files, exportPadding: 20 });
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('style', 'max-width: 100%; height: auto;');
      updateAttributes({
        diagramData: JSON.stringify(sceneData),
        svgData: svg.outerHTML,
      });
    } catch (err) {
      console.error('Failed to export Excalidraw diagram:', err);
    } finally {
      setIsEditing(false);
    }
  };

  return (
    <NodeViewWrapper className="excalidraw-node-wrapper">
      <DiagramModal
        isOpen={isEditing && initialData !== null}
        onClose={() => setIsEditing(false)}
        title="Edit excalidraw diagram"
        fullscreen
        headerAction={
          <button type="button" className="diagram-primary" onClick={handleSave}>Save</button>
        }
      >
        <div className="excalidraw-editor">
          <Suspense fallback={<div className="diagram-placeholder">Loading editor…</div>}>
            <ExcalidrawLazy excalidrawAPI={setExcalidrawApi} initialData={initialData} />
          </Suspense>
        </div>
      </DiagramModal>
      <div className="diagram-node-container" data-diagram-node="excalidraw">
        {hasData && node.attrs.svgData ? (
          <>
            <div className="diagram-node-actions with-theme">
              <button
                type="button"
                className="diagram-action"
                title={`Switch to ${themeMode === 'dark' ? 'light' : 'dark'} mode`}
                onClick={() => {
                  const next = themeMode === 'dark' ? 'light' : 'dark';
                  setThemeMode(next);
                  updateAttributes({ themeMode: next });
                }}
              >
                {themeMode === 'dark' ? '☀' : '☾'}
              </button>
              <button type="button" className="diagram-action" title="Edit diagram" onClick={() => setIsEditing(true)}>Edit</button>
              <button type="button" className="diagram-action diagram-danger" title="Delete diagram" onClick={() => setShowDeleteModal(true)}>Delete</button>
            </div>
            <div
              className="diagram-svg-wrap"
              style={{ filter: diagramFilterFor(themeMode) }}
              dangerouslySetInnerHTML={{ __html: String(node.attrs.svgData ?? '') }}
            />
          </>
        ) : (
          <div className="diagram-create-row">
            <button type="button" className="diagram-primary" onClick={() => setIsEditing(true)}>Create visual diagram</button>
            <button type="button" className="diagram-danger" onClick={() => setShowDeleteModal(true)}>Delete</button>
          </div>
        )}
      </div>
      <DiagramConfirmModal
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        onConfirm={() => {
          deleteNode();
          setShowDeleteModal(false);
        }}
        title="Delete"
        message="Delete this excalidraw diagram?"
        confirmText="Delete"
      />
    </NodeViewWrapper>
  );
};
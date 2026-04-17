'use client';

import { useRef, useCallback } from 'react';
import { Paperclip, X, FileText, Image as ImageIcon, AlertCircle } from 'lucide-react';

export interface PendingAttachment {
  id: string;          // local temp id (before upload)
  file: File;
  previewUrl?: string; // object URL for images
  uploadedId?: number; // server id after upload succeeds
  error?: string;
  uploading?: boolean;
}

const ALLOWED_TYPES = [
  'image/', 'text/', 'application/pdf', 'application/json',
  'application/zip', 'application/x-zip', 'application/msword',
  'application/vnd.openxmlformats-officedocument', 'application/octet-stream',
];
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB

export function validateFile(file: File): string | null {
  if (file.size > MAX_SIZE) return `${file.name}: file too large (max 25 MB)`;
  const allowed = ALLOWED_TYPES.some(p => file.type.startsWith(p));
  if (!allowed) return `${file.name}: file type not supported`;
  return null;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ─── Upload button ────────────────────────────────────────────────────────────
interface UploadButtonProps {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}

export function AttachmentUploadButton({ onFiles, disabled }: UploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        multiple
        className="hidden"
        accept="image/*,.pdf,.txt,.md,.json,.csv,.zip,.doc,.docx"
        onChange={e => {
          const files = Array.from(e.target.files ?? []);
          if (files.length) onFiles(files);
          // reset so same file can be picked again
          e.target.value = '';
        }}
      />
      <button
        type="button"
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        title="Attach file"
        className="flex items-center justify-center w-9 h-9 rounded-lg text-slate-400 hover:text-amber-400 hover:bg-slate-700/60 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0"
      >
        <Paperclip className="w-4 h-4" />
      </button>
    </>
  );
}

// ─── Preview strip ────────────────────────────────────────────────────────────
interface PreviewStripProps {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}

export function AttachmentPreviewStrip({ attachments, onRemove }: PreviewStripProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-2 px-5 pt-3 pb-0">
      {attachments.map(a => (
        <AttachmentChip key={a.id} attachment={a} onRemove={() => onRemove(a.id)} />
      ))}
    </div>
  );
}

function AttachmentChip({ attachment, onRemove }: { attachment: PendingAttachment; onRemove: () => void }) {
  const isImage = attachment.file.type.startsWith('image/');
  const hasError = !!attachment.error;

  return (
    <div className={`relative flex items-center gap-2 rounded-lg border px-2 py-1.5 text-xs max-w-[180px] group
      ${hasError
        ? 'bg-red-900/20 border-red-700/50 text-red-300'
        : attachment.uploading
          ? 'bg-slate-700/40 border-slate-600/50 text-slate-400 animate-pulse'
          : 'bg-slate-700/60 border-slate-600/50 text-slate-300'
      }`}
    >
      {/* Thumbnail or icon */}
      {isImage && attachment.previewUrl && !hasError ? (
        <img
          src={attachment.previewUrl}
          alt={attachment.file.name}
          className="w-8 h-8 rounded object-cover shrink-0"
        />
      ) : hasError ? (
        <AlertCircle className="w-4 h-4 shrink-0 text-red-400" />
      ) : isImage ? (
        <ImageIcon className="w-4 h-4 shrink-0 text-slate-400" />
      ) : (
        <FileText className="w-4 h-4 shrink-0 text-slate-400" />
      )}

      {/* Name + size */}
      <div className="min-w-0">
        <p className="truncate font-medium leading-tight" title={attachment.file.name}>
          {attachment.file.name}
        </p>
        {hasError ? (
          <p className="text-red-400 truncate leading-tight" title={attachment.error}>
            {attachment.error}
          </p>
        ) : (
          <p className="text-slate-500 leading-tight">{formatBytes(attachment.file.size)}</p>
        )}
      </div>

      {/* Remove button */}
      <button
        type="button"
        onClick={onRemove}
        className="absolute -top-1.5 -right-1.5 w-4 h-4 rounded-full bg-slate-600 border border-slate-500 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity hover:bg-red-700/80"
        title="Remove"
      >
        <X className="w-2.5 h-2.5" />
      </button>
    </div>
  );
}

// ─── Drop zone hook ───────────────────────────────────────────────────────────
export function useDragDrop(onFiles: (files: File[]) => void, enabled: boolean) {
  const isDragging = useRef(false);

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!enabled) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  }, [enabled]);

  const onDrop = useCallback((e: React.DragEvent) => {
    if (!enabled) return;
    e.preventDefault();
    const files = Array.from(e.dataTransfer.files);
    if (files.length) onFiles(files);
  }, [enabled, onFiles]);

  return { onDragOver, onDrop, isDragging };
}

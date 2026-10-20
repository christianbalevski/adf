import { useState } from 'react'
import { deletedFilePlaceholder, type DisplayAttachment } from '../../../shared/utils/file-ref'

/** Placeholder for a file a message refers to that is gone. Same text the model receives. */
function DeletedFile({ name }: { name: string }) {
  return <span className="text-xs text-[var(--ink-faint)]">{deletedFilePlaceholder({ path: name })}</span>
}

/** File name of an `adf-file://` URL (for the placeholder when it no longer loads). */
function nameOfUrl(url: string): string {
  if (!url.startsWith('adf-file://')) return 'image'
  const last = url.slice('adf-file://'.length).split('/').pop() ?? ''
  try {
    return decodeURIComponent(last) || 'image'
  } catch {
    return last || 'image'
  }
}

/**
 * An image in the chat. A file deleted after the chat was loaded (or by
 * another client) fails to load and shows `[deleted: name]` instead.
 */
export function AttachedImage({ url, name, alt, className }: { url: string; name?: string; alt?: string; className: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <DeletedFile name={name ?? nameOfUrl(url)} />
  return <img src={url} alt={alt ?? name ?? 'image'} className={className} onError={() => setFailed(true)} />
}

/**
 * The references an image preview does not show: deleted files and audio or
 * video. Images that still exist are rendered from `imagePreviewUrls`.
 */
export function AttachmentList({ attachments, align = 'end' }: { attachments: DisplayAttachment[]; align?: 'start' | 'end' }) {
  const rows = attachments.filter(a => a.deleted || a.kind !== 'image')
  if (rows.length === 0) return null
  return (
    <div className={`flex max-w-[85%] flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {rows.map((a, index) => a.deleted
        ? <DeletedFile key={`${a.path}-${index}`} name={a.name} />
        : (
          <span key={`${a.path}-${index}`} title={a.path} className="rounded border border-[var(--rule)] px-1.5 py-0.5 text-xs text-[var(--ink-muted)]">
            {a.name}
          </span>
        ))}
    </div>
  )
}

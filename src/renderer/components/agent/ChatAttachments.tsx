import { mediaUrl } from '../../utils/media-url'
import { useState } from 'react'
import { adfFileUrl, deletedFilePlaceholder, type DisplayAttachment } from '../../../shared/utils/file-ref'

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
  return <img src={mediaUrl(url)} alt={alt ?? name ?? 'image'} className={className} onError={() => setFailed(true)} />
}

const CHIP = 'inline-flex max-w-[14rem] items-center gap-1.5 rounded-[var(--radius-sm)] border border-[var(--rule)] bg-[var(--paper-sunken)] px-2 py-1 text-[11px] text-[var(--ink)]'

/** One attachment as a compact chip: a thumbnail for an image, then its name. */
function AttachmentChip({ attachment }: { attachment: DisplayAttachment }) {
  const [failed, setFailed] = useState(false)
  if (attachment.deleted || failed) {
    return <span className={CHIP} title={attachment.path}><DeletedFile name={attachment.name} /></span>
  }
  return (
    <span className={CHIP} title={attachment.path}>
      {attachment.kind === 'image' && (
        <img src={mediaUrl(adfFileUrl(attachment.path))} alt="" className="h-5 w-5 shrink-0 rounded-sm object-cover" onError={() => setFailed(true)} />
      )}
      <span className="truncate">{attachment.name}</span>
      <span className="shrink-0 font-mono text-[var(--ink-faint)]">{attachment.kind ?? 'file'}</span>
    </span>
  )
}

/**
 * A message's attachments as chips under its text. `deletedOnly`: a tool
 * result already previews the file it read, so only a deleted one is shown.
 */
export function AttachmentList({ attachments, align = 'end', deletedOnly = false }: { attachments: DisplayAttachment[]; align?: 'start' | 'end'; deletedOnly?: boolean }) {
  const rows = deletedOnly ? attachments.filter(a => a.deleted) : attachments
  if (rows.length === 0) return null
  return (
    <div className={`flex max-w-[85%] flex-wrap gap-1.5 ${align === 'end' ? 'justify-end' : 'justify-start'}`}>
      {rows.map((a, index) => <AttachmentChip key={`${a.path}-${index}`} attachment={a} />)}
    </div>
  )
}

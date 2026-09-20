import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_INLINE_BINARY_BYTES, resolveImageMime } from '../../../shared/utils/image-files'

interface Props {
  filePath: string
  /** Canonical image type the tab was dispatched on (see resolveImageMime). */
  mime: string
}

type LoadState =
  | { status: 'loading' }
  | { status: 'ready'; url: string; size: number; mime: string }
  | { status: 'too-large'; size: number }
  | { status: 'missing' }
  | { status: 'failed' }

/** Padding around the image on the stage (p-4), both sides. */
const STAGE_PADDING = 32

const FOOTER_BUTTON =
  'px-1.5 py-0.5 rounded hover:bg-[var(--adf-ui-surface-hover)] hover:text-[var(--adf-ui-text)] disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-[var(--adf-ui-text-muted)]'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function base64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Read-only view of an image in the agent's workspace. The tab holds no bytes:
 * the viewer reads the file when it mounts (so returning to the tab shows the
 * current image), wraps it in a blob: URL, and revokes that URL on unmount.
 *
 * Workspace files are untrusted — agents write them. Every format, SVG
 * included, is shown through <img> only, where Chromium renders SVG without
 * running its scripts or loading anything it references. The markup is never
 * parsed into this document, and the blob's type comes from the
 * resolveImageMime allowlist rather than from the stored mime string.
 *
 * There is no live refresh: the runtime's `file_updated` event carries text
 * content only, so a binary write while the tab is showing needs Reload.
 */
export function ImageViewer({ filePath, mime }: Props) {
  const [state, setState] = useState<LoadState>({ status: 'loading' })
  const [reloadSeq, setReloadSeq] = useState(0)
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null)
  const [stage, setStage] = useState<{ width: number; height: number } | null>(null)
  const [actualSize, setActualSize] = useState(false)
  const stageRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let url: string | null = null
    setState({ status: 'loading' })
    setNatural(null)
    const read = window.adfApi?.readInternalFile(filePath, { binaryContent: true })
    if (!read) {
      setState({ status: 'failed' })
      return
    }
    read
      .then((file) => {
        // Unmounted, or the agent was switched while the read was in flight —
        // main answers from whatever workspace is open, so this may not even
        // be our file.
        if (cancelled) return
        if (file.content == null) {
          setState({ status: 'missing' })
          return
        }
        const size = file.size ?? 0
        if (file.tooLarge) {
          setState({ status: 'too-large', size })
          return
        }
        // The file may have been replaced since the tab opened; trust the
        // fresh row over the tab's copy, still through the allowlist.
        const type = resolveImageMime(filePath, file.mimeType) ?? mime
        url = URL.createObjectURL(new Blob([base64ToBytes(file.content)], { type }))
        setState({ status: 'ready', url, size, mime: type })
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'failed' })
      })
    return () => {
      cancelled = true
      if (url) URL.revokeObjectURL(url)
    }
  }, [filePath, mime, reloadSeq])

  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = (): void => setStage({ width: el.clientWidth, height: el.clientHeight })
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const reload = useCallback(() => setReloadSeq((n) => n + 1), [])

  // Fit never upscales, so an image that already fits is at 100% in both modes
  // and there is nothing to toggle.
  const fitScale =
    natural && stage && natural.width > 0 && natural.height > 0
      ? Math.min(
          1,
          Math.max(1, stage.width - STAGE_PADDING) / natural.width,
          Math.max(1, stage.height - STAGE_PADDING) / natural.height
        )
      : 1
  const canToggle = fitScale < 1
  const showActual = actualSize && canToggle
  const toggleSize = useCallback(() => setActualSize((v) => !v), [])

  // The box is sized in pixels from the measured stage rather than with
  // max-width/max-height: an <img> that is a flex item resolves those two
  // limits independently and comes out squashed. Zero-sized until it has
  // loaded, so a large image never flashes at full size first.
  const hasIntrinsicSize = natural != null && natural.width > 0 && natural.height > 0
  const scale = showActual ? 1 : fitScale
  const imageStyle = !natural
    ? { width: 0, height: 0 }
    : hasIntrinsicSize
      ? { width: Math.max(1, Math.floor(natural.width * scale)), height: Math.max(1, Math.floor(natural.height * scale)) }
      : undefined

  const fileName = filePath.split('/').pop() ?? filePath

  return (
    <div className="h-full flex flex-col">
      <div ref={stageRef} className="relative flex-1 min-h-0 bg-surface-0">
        {state.status === 'ready' ? (
          // `m-auto` inside a flex box centers the image while it fits and
          // pins it to the top-left once it overflows, so every part of an
          // actual-size image can be scrolled to (centering with
          // justify/align would cut off the top and left).
          <div className="absolute inset-0 flex overflow-auto p-4">
            <img
              src={state.url}
              alt={fileName}
              draggable={false}
              onLoad={(e) => setNatural({ width: e.currentTarget.naturalWidth, height: e.currentTarget.naturalHeight })}
              onError={() => setState({ status: 'failed' })}
              onClick={canToggle ? toggleSize : undefined}
              style={imageStyle}
              // An SVG with no width/height of its own reports no natural
              // size; it gets the whole stage instead of a pixel box.
              className={`image-checkerboard m-auto shrink-0 max-w-none ${
                natural && !hasIntrinsicSize ? 'w-full h-full object-contain' : ''
              } ${canToggle ? (showActual ? 'cursor-zoom-out' : 'cursor-zoom-in') : ''}`}
            />
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-neutral-400 dark:text-neutral-500">
            {state.status === 'loading' && <span className="text-xs">Loading image</span>}
            {state.status === 'missing' && <span className="text-xs">File not found: {filePath}</span>}
            {state.status === 'failed' && (
              <>
                <span className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{fileName}</span>
                <span className="text-xs">This file could not be displayed as an image.</span>
              </>
            )}
            {state.status === 'too-large' && (
              <>
                <span className="text-sm font-medium text-neutral-500 dark:text-neutral-400">{fileName}</span>
                <span className="text-xs">
                  This image is {formatSize(state.size)}. Images larger than {formatSize(MAX_INLINE_BINARY_BYTES)} are not displayed.
                </span>
                <button
                  onClick={() => window.adfApi?.downloadInternalFile(filePath)}
                  className="px-3 py-1.5 text-xs font-medium rounded-md border border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800"
                >
                  Download
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div className="shrink-0 flex items-center gap-3 h-7 px-3 border-t border-hairline bg-surface-1 text-[11px] text-[var(--adf-ui-text-muted)]">
        {state.status === 'ready' && (
          <>
            {hasIntrinsicSize && (
              <span className="font-mono">{natural.width} × {natural.height}</span>
            )}
            <span>{formatSize(state.size)}</span>
            <span className="font-mono">{state.mime}</span>
            {hasIntrinsicSize && <span className="font-mono">{Math.round(scale * 100)}%</span>}
          </>
        )}
        <span className="flex-1" />
        {state.status === 'ready' && (
          <button onClick={toggleSize} disabled={!canToggle} aria-pressed={showActual} className={FOOTER_BUTTON}>
            {showActual ? 'Fit to view' : 'Actual size'}
          </button>
        )}
        <button onClick={reload} disabled={state.status === 'loading'} className={FOOTER_BUTTON}>
          Reload
        </button>
      </div>
    </div>
  )
}

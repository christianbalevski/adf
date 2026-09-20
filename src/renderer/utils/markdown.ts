import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { createIncrementalRenderer } from './markdown-split'

/**
 * The one sanitized markdown → HTML path in the renderer.
 *
 * Everything this renders is untrusted: model output in the loop, a peer's
 * files, a SKILL.md fetched from a catalog nobody in this process controls. So
 * the parse is always followed by DOMPurify with the same allowlist rather than
 * by any per-caller variation — `marked` does not sanitize, and a second copy of
 * this configuration is a second chance to get it wrong.
 *
 * Callers own their own pre-processing (the loop percent-encodes adf-file://
 * URLs, the skill preview strips control characters) and pass the result here.
 */

// Loop messages depend on `breaks`, and one global marked configuration is the
// only kind there is — set it where the sanitizer lives so no caller can render
// through a differently-configured parser.
marked.use({ async: false, breaks: true })

export function renderMarkdownToSafeHtml(source: string): string {
  const raw = marked.parse(source) as string
  return DOMPurify.sanitize(raw, {
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|adf-file):|[^a-z]|[a-z+.\-]+(?:[^a-z+.\-:]|$))/i,
    FORBID_TAGS: ['style', 'form', 'input', 'textarea', 'select'],
    FORBID_ATTR: ['style'],
  })
}

/**
 * A renderer for ONE growing document (a streaming answer), with the settled
 * prefix's HTML kept between calls.
 *
 * Re-parsing the whole answer on each of the ~20 deltas a second the loop
 * delivers is quadratic in its length; here each delta only re-parses the block
 * still being written, and each finished block is parsed exactly once. The
 * first call — and any call whose text is not simply the previous text plus
 * more — parses the whole thing, so a log row that never streams (history, a
 * re-read transcript) behaves exactly as it always did.
 *
 * `preprocess` runs per parsed segment; it must be line-local (the loop's
 * adf-file:// percent-encoding is) so applying it per segment matches applying
 * it to the whole document.
 */
export function createIncrementalMarkdownRenderer(
  preprocess: (source: string) => string = (source) => source
): (source: string) => string {
  return createIncrementalRenderer((source) => renderMarkdownToSafeHtml(preprocess(source)))
}

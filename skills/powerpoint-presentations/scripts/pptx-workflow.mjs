// JSZip-only facade: generation lives in pptx-generate.mjs so optional pptxgenjs
// is not imported for inspect/patch workflows.
export {
  MAX_PPTX_BYTES,
  MAX_SLIDE_PARTS,
  inspectPackage,
  patchSlideText,
  vfsBytes,
  vfsWritePayload,
} from './pptx-inspect-patch.mjs'

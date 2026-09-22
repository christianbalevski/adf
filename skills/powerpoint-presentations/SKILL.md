---
name: powerpoint-presentations
description: Create and cautiously inspect PowerPoint PPTX files in ADF with optional PptxGenJS generation and narrow JSZip XML patches; use for new decks or explicitly bounded existing-deck edits.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, sys_code, sys_lambda]
---

# PowerPoint presentations in ADF

Use this skill to generate a new `.pptx`, inspect its OOXML package, or perform a narrowly preconditioned text patch in a known slide XML part. PptxGenJS is optional; it is not an ADF standard-library package. The inspect/patch path uses JSZip only and must not require PptxGenJS.

## Decide generation versus existing-deck editing

- **New deck:** use `scripts/pptx-generate.mjs`. It imports PptxGenJS only when the generation path is selected and the optional package is available. This is a regeneration workflow.
- **Existing deck, narrow text change:** use `scripts/pptx-inspect-patch.mjs` (or the JSZip-only facade `scripts/pptx-workflow.mjs`). It has no PptxGenJS import. Inspect the package, identify the exact `ppt/slides/slideN.xml` part, and apply one exact text-node patch.
- **Existing deck, broad or structural change:** stop and state that full-fidelity arbitrary editing is not supported here. A request involving layouts, charts, SmartArt, tables, media, notes, animations, themes, macros, custom XML, relationships, signatures, or many slides needs a dedicated OOXML-aware workflow or an explicit regeneration brief. Do not pretend PptxGenJS preserves all of it.

## Non-negotiable workflow

1. **Preflight the selected path.** Confirm `fs_read`, `fs_write`, `sys_code`, and `sys_lambda` are available for the helper bridge. For inspect/patch, preflight JSZip and do not preflight or import PptxGenJS. For generation, conditionally check `pptxgenjs`; if it is absent, stop unless the actual `npm_install` tool is enabled and authorized by runtime policy. A skill never enables tools or authorization.
2. **Preserve first.** Read the source deck in `sys_code`, decode base64, and never overwrite it. Use an explicit output path such as `output/generated.pptx` or `output/source-title-patched.pptx`.
3. **Validate package identity and safety.** Preflight the ZIP local headers and central-directory metadata before JSZip decompression. Require non-empty bytes, a ZIP signature, `[Content_Types].xml`, and `ppt/presentation.xml`; reject more than 12,000 entries, ZIP64/multidisk/encrypted/data-descriptor/duplicate/mismatched entries, and compressed or expanded package/entry sizes over the helper caps. Re-check actual expanded bytes after load. Reject malformed/non-PPTX bytes, macro-enabled content types, VBA, ActiveX, OLE, and executable/embedded object entries before ordinary `.pptx` patch output. Keep a slide-part cap.
4. **Generate or patch narrowly.** For generation, construct a new deck from a typed specification. For patching, use `slidePartNumber`, which means the XML file part `ppt/slides/slideN.xml`, **not** the visible slide ordinal. Resolve a visible ordinal through the presentation relationships before calling the helper. Require exactly one complete `<a:t ...>TEXT</a:t>` node; do not match attributes, partial text, or split runs. Cap replacement/source text at 50 MiB UTF-8 before ZIP generation, and run the same metadata/expanded safety validation on the generated output before returning it.
5. **Preserve text semantics.** Escape XML text (`&`, `<`, `>`); reject literal angle brackets in replacement text and XML 1.0-invalid controls. Reject leading/trailing whitespace changes unless the matched opening tag carries `xml:space="preserve"`; preserve that opening tag and its attributes. Use explicit slicing/callback semantics so replacement text such as `$& cost` stays literal.
6. **Write binary explicitly.** Call `adf.fs_write({ mode: 'write', path: outputPath, content: Buffer.from(bytes).toString('base64'), encoding: 'base64', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })`.
7. **Reopen and inspect.** Load the output again with JSZip and check slide-part count and target entry. When visual fidelity matters, open/render the result in a PowerPoint-compatible viewer and inspect the actual rendered slide images. A valid ZIP or package metadata is not visual validation.
8. **Report honestly.** Name the output path, original-preservation status, package/slide checks, whether a real viewer was available, and the limitations of generation or patching. Do not claim full fidelity or successful visual rendering without looking at the rendered output. Deliver VFS artifacts with an explicit link such as `[deck](adf-file://output/generated.pptx)`.

## JSZip-only inspect and patch example

Copy the repository helper `scripts/pptx-inspect-patch.mjs` to a workspace path such as `lib/pptx-inspect-patch.mjs` without editing its validation logic. The helper exposes a tested base64 bridge so the ADF invocation does not duplicate ZIP/XML parsing. Read the source, preserve its hash, invoke the helper, write a different output path, then reopen the saved output and invoke the helper's inspection bridge:

```javascript
const helper = 'lib/pptx-inspect-patch.mjs'
const inputPath = 'input/source.pptx'
const outputPath = 'output/source-patched.pptx'
const source = await adf.fs_read({ path: inputPath })
if (source.mime_type !== 'application/vnd.openxmlformats-officedocument.presentationml.presentation' || !source.content) {
  throw new Error('Expected a non-empty binary PPTX payload')
}
const originalBase64 = source.content
const patchedBase64 = await adf.sys_lambda({
  source: `${helper}:patchSlideTextFromBase64`,
  args: { inputBase64: originalBase64, slidePartNumber: 1, from: 'Old text', to: 'New text' },
})
if (typeof patchedBase64 !== 'string' || patchedBase64 === originalBase64) throw new Error('Patch did not return changed PPTX bytes')
await adf.fs_write({
  mode: 'write', path: outputPath, content: patchedBase64, encoding: 'base64',
  mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
})
const saved = await adf.fs_read({ path: outputPath })
const info = await adf.sys_lambda({
  source: `${helper}:inspectPackageFromBase64`,
  args: { inputBase64: saved.content },
})
console.log({ inputPath, outputPath, slideCount: info.slideCount, preservedOriginal: true, packageValidated: true })
```

The helper requires a complete, single `<a:t>` text node and treats `slidePartNumber` as the OOXML part number, not visible slide order. It escapes replacement text, rejects XML 1.0-invalid characters including U+FFFE/U+FFFF, rejects split or ambiguous runs, checks ZIP limits before decompression, rejects macros/ActiveX/OLE embeddings, and validates the generated package. A missing exact match is a meaningful failure; do not broaden the patch unsafely. `vfsBytes` and `vfsWritePayload` are async and perform full `inspectPackage` validation, not merely MIME/signature checks.

Deliver the resulting VFS artifact with an explicit link such as `[patched deck](adf-file://output/source-patched.pptx)`. This is intentionally not a generic “edit any PPTX” function.

## Conditional generation and package capability

Generation is the only path that needs PptxGenJS. Keep the optional import conditional; do not make JSZip-only inspection or patching depend on it.

```javascript
let pptxgen
try {
  pptxgen = await __require('pptxgenjs')
} catch (error) {
  // Only call this if the actual runtime reports npm_install enabled and authorized.
  // If npm_install is unavailable, disabled, or unauthorized, stop and report that
  // capability requirement; do not enable it from the skill or retry in a loop.
  const tools = await adf.sys_get_config({ section: 'tools' })
  const npmInstall = tools?.tools?.find?.((tool) => tool.name === 'npm_install')
  if (!npmInstall?.enabled || npmInstall.restricted) {
    throw new Error('PptxGenJS is absent and npm_install is not enabled/authorized in this runtime')
  }
  await adf.npm_install({ name: 'pptxgenjs', version: '^3.12.0' })
  throw new Error('PptxGenJS installed; retry generation on the next turn')
}
const pptx = new pptxgen()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'ADF'
pptx.title = 'Quarterly review'
const slide = pptx.addSlide()
slide.addText('Quarterly review', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 26, bold: true, color: '17365D' })
slide.addText('Generated from an explicit specification.', { x: 0.9, y: 1.5, w: 11.4, h: 1, fontSize: 18, fit: 'shrink' })
const bytes = await pptx.write({ outputType: 'nodebuffer' })
await adf.fs_write({ mode: 'write', path: 'output/generated.pptx', content: Buffer.from(bytes).toString('base64'), encoding: 'base64', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })
```

The exact package call is `await adf.npm_install({ name: 'pptxgenjs', version: '^3.12.0' })`; the optional package becomes importable on the next turn. `requires` deliberately does not list `npm_install`: generation is conditional, and inspect/patch must work without it. The runtime may expose the tool as unavailable or with an empty schema; report that registration/capability blocker rather than claiming sandbox generation.

## Tests and evidence

With optional packages installed in an isolated checkout, run:

```sh
cd skills/powerpoint-presentations
node --test tests/*.mjs
```

The suites include a JSZip-only inspect/patch test, ordinary generated deck package checks, `slidePartNumber` part-target tests, XML entity/attribute and literal-dollar handling, whitespace and split-run failures, exact XML 1.0 controls including U+FFFE/U+FFFF, canonical base64/MIME/ZIP-signature checks, SHA-256 input preservation, pre-decompression ZIP expanded-size and 12,000-entry caps, local/central metadata mismatch/data-descriptor failures, pre-generation oversized replacement rejection, output-accepted-by-inspect invariant, unsupported ZIP input, and synthetic macro/VBA/ActiveX/executable-embedding rejection. The isolated evidence uses Node 20 with `pptxgenjs@3.12.0` and `jszip@3.10.1`; it does not prove the current agent sandbox can import PptxGenJS. No visual slide renderer is assumed or claimed. See `references/limitations.md` and `scripts/pptx-inspect-patch.mjs`.

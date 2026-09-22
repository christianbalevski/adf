---
name: powerpoint-presentations
description: Create and cautiously inspect PowerPoint PPTX files in ADF with PptxGenJS and narrow JSZip XML patches; use for new decks or explicitly bounded existing-deck edits.
adf: ">=0.2"
requires:
  tools: [fs_read, fs_write, sys_code, npm_install]
---

# PowerPoint presentations in ADF

Use this skill to generate a new `.pptx`, inspect its OOXML package, or perform a narrowly preconditioned text patch in a known slide XML entry. PptxGenJS is an optional package, not an ADF standard-library package. If it is absent, request the normal `npm_install` approval/path and wait for the next execution turn; never silently substitute an unverified library or enable a tool yourself.

## Decide generation versus existing-deck editing

- **New deck:** use PptxGenJS and the helper in `scripts/pptx-workflow.mjs`. This is a regeneration workflow.
- **Existing deck, narrow text change:** use JSZip to inspect the package, identify the exact `ppt/slides/slideN.xml` entry and one exact text occurrence, then apply the helper's escaped replacement. This is a deliberately narrow XML patch, not a general editor.
- **Existing deck, broad or structural change:** stop and state that full-fidelity arbitrary editing is not supported here. A request involving layouts, charts, SmartArt, tables, media, notes, animations, themes, macros, custom XML, relationships, signatures, or many slides needs a dedicated OOXML-aware workflow or an explicit regeneration brief. Do not pretend PptxGenJS preserves all of it.

## Non-negotiable workflow

1. **Preflight.** Confirm `fs_read`, `fs_write`, `sys_code`, and `npm_install`. Check whether `pptxgenjs` is available to the sandbox. If not, install only after the normal capability approval; package installation becomes usable on the next turn. `jszip` is an ADF standard-library package.
2. **Preserve first.** Read the source deck in `sys_code`, decode base64, and never overwrite it. Use an explicit output path such as `output/generated.pptx` or `output/source-title-patched.pptx`.
3. **Validate package identity.** Use JSZip and require `[Content_Types].xml` plus `ppt/presentation.xml`; for an existing deck list slide entries and confirm the target slide exists. Refuse malformed or non-PPTX bytes.
4. **Generate or patch narrowly.** For generation, construct a new deck from a typed specification. For a patch, require exactly one match, escape XML text (`&`, `<`, `>`), reject markup, and change only the selected slide entry. Never use regex to perform broad XML restructuring.
5. **Write binary explicitly.** Call `adf.fs_write({ mode: 'write', path: outputPath, content: Buffer.from(bytes).toString('base64'), encoding: 'base64', mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' })`.
6. **Reopen and inspect.** Load the output again with JSZip and check slide count/target entry. When visual fidelity matters, open/render the result in a PowerPoint-compatible viewer and inspect the actual rendered slide images. A valid ZIP or package metadata is not visual validation.
7. **Report honestly.** Name the output path, original-preservation status, package/slide checks, whether a real viewer was available, and the limitations of generation or patching. Do not claim full fidelity or successful visual rendering without looking at the rendered output.

## Runnable `sys_code` examples

The repository helper is `scripts/pptx-workflow.mjs`. Copy it to `lib/` or use its functions in `sys_code` after the package preflight.

### Create a new presentation

```javascript
import pptxgen from 'pptxgenjs'
const outputPath = 'output/new-deck.pptx'
const pptx = new pptxgen()
pptx.layout = 'LAYOUT_WIDE'
pptx.author = 'ADF'
pptx.title = 'Quarterly review'
const slide = pptx.addSlide()
slide.addText('Quarterly review', { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 26, bold: true, color: '17365D' })
slide.addText('Generated from an explicit specification.', { x: 0.9, y: 1.5, w: 11.4, h: 1, fontSize: 18, fit: 'shrink' })
const bytes = await pptx.write({ outputType: 'nodebuffer' })
await adf.fs_write({
  mode: 'write', path: outputPath,
  content: Buffer.from(bytes).toString('base64'), encoding: 'base64',
  mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
})
```

### Patch one known text occurrence in an existing deck

```javascript
import JSZip from 'jszip'
const inputPath = 'input/source.pptx'
const outputPath = 'output/source-patched.pptx'
const file = await adf.fs_read({ path: inputPath })
if (!file.content) throw new Error('Expected a binary PPTX payload')
const input = Buffer.from(file.content, 'base64')
const zip = await JSZip.loadAsync(input)
if (!zip.file('[Content_Types].xml') || !zip.file('ppt/presentation.xml')) throw new Error('Not a PPTX package')
const target = 'ppt/slides/slide1.xml'
const entry = zip.file(target)
if (!entry) throw new Error(`Missing ${target}`)
const xml = await entry.async('string')
const from = 'Old text'
const to = 'New text'
const invalidXmlControl = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/
if (invalidXmlControl.test(from) || invalidXmlControl.test(to)) throw new TypeError('from/to contain invalid XML control characters')
if (/[<>]/.test(to)) throw new TypeError('to must be text, not XML markup')
const escapeXmlText = (value) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const encodedFrom = escapeRegex(escapeXmlText(from))
const matches = [...xml.matchAll(new RegExp(`<a:t(?:\\s[^>]*)?>${encodedFrom}</a:t>`, 'g'))]
if (matches.length !== 1) throw new Error(`Expected exactly one complete a:t text-node match, found ${matches.length}`)
const matched = matches[0][0]
const openEnd = matched.indexOf('>')
const replacement = matched.slice(0, openEnd + 1) + escapeXmlText(to) + '</a:t>'
const offset = matches[0].index
zip.file(target, xml.slice(0, offset) + replacement + xml.slice(offset + matched.length))
const output = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
await adf.fs_write({
  mode: 'write', path: outputPath,
  content: Buffer.from(output).toString('base64'), encoding: 'base64',
  mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
})
console.log({ inputPath, outputPath, target, preservedOriginal: true, patchScope: 'one complete a:t text node' })
```

Deliver the resulting VFS artifact with an explicit link such as `[patched deck](adf-file://output/source-patched.pptx)`. This patch is intentionally not a generic “edit any PPTX” function. PowerPoint may split visible text across multiple `<a:t>` nodes, so a missing exact match is a meaningful failure, not permission to broaden the patch unsafely.

## Package installation and sandbox compatibility

`jszip` is listed in the ADF code-execution standard library. `pptxgenjs` is not. A portable skill must therefore:

- preflight the package through the exact sandbox/module resolver;
- call `npm_install({ name: 'pptxgenjs', version: '^3.12.0' })` only if the principal has allowed package installation;
- remember that an installed package is importable starting on the **next turn**;
- use only pure JavaScript packages accepted by ADF; do not install native addons for this workflow;
- record the actual package/version and environment in test evidence.

The isolated repository test uses Node 20 with `pptxgenjs@3.12.0` and `jszip@3.10.1`. That verifies the helpers in a Node module environment, not the agent's sandbox package resolver. A sandbox run must separately verify the import after installation; do not present the isolated Node result as proof that the current agent can import PptxGenJS.

## Tests and evidence

With the optional packages installed in an isolated checkout, run:

```sh
cd skills/powerpoint-presentations
node --test tests/pptx-workflow.test.mjs
```

The tests create a deck, reopen it as an OOXML package, apply one exact escaped text patch, verify explicit VFS base64 conversion, and assert meaningful failures for absent/ambiguous targets and markup. They do not render slides. If LibreOffice, PowerPoint, or another compatible viewer is absent, report that visual validation remains outstanding. See `references/limitations.md` and `scripts/pptx-workflow.mjs`.

import pptxgen from 'pptxgenjs'

export const MAX_GENERATED_SLIDES = 1000

/** Create a new ordinary PPTX. Import this module only when pptxgenjs is available. */
export async function createPresentation({ title = 'ADF presentation', slides = [] } = {}) {
  if (!Array.isArray(slides)) throw new TypeError('slides must be an array')
  if (slides.length > MAX_GENERATED_SLIDES) throw new RangeError(`slides exceeds ${MAX_GENERATED_SLIDES} slide safety cap`)
  const pptx = new pptxgen()
  pptx.layout = 'LAYOUT_WIDE'
  pptx.author = 'ADF'
  pptx.title = title
  for (const [index, spec] of slides.entries()) {
    if (!spec || typeof spec !== 'object' || typeof spec.title !== 'string') {
      throw new TypeError(`slides[${index}] must have a string title`)
    }
    const slide = pptx.addSlide()
    slide.addText(spec.title, { x: 0.7, y: 0.5, w: 12, h: 0.6, fontSize: 26, bold: true, color: '17365D' })
    if (spec.body !== undefined) {
      if (typeof spec.body !== 'string') throw new TypeError(`slides[${index}].body must be a string`)
      slide.addText(spec.body, { x: 0.9, y: 1.5, w: 11.4, h: 4.5, fontSize: 18, breakLine: false, fit: 'shrink' })
    }
  }
  return new Uint8Array(await pptx.write({ outputType: 'nodebuffer' }))
}

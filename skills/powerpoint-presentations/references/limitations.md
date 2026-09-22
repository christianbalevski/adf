# PowerPoint capability and safety notes

- PptxGenJS is used for **new deck generation**. It is not a full-fidelity editor for arbitrary existing PPTX files.
- For a narrowly scoped existing-deck change, inspect the OOXML ZIP first and apply a preconditioned, exact XML patch only to a known entry. Preserve the original and use an explicit output path. Refuse ambiguous matches, missing relationships, or markup injection.
- A regenerated ZIP is not proof of visual fidelity. Theme inheritance, charts, SmartArt, embedded media, notes, animations, custom XML, external links, macros, and relationship IDs can carry behavior not covered by a narrow patch. Signed packages will not remain valid after rewrites.
- Never claim arbitrary PPTX editing support from a generation helper. If the requested change is broader than a safe narrow XML patch, use a dedicated OOXML library or ask for a regeneration specification.
- Validate package structure and, where possible, render/open the output in a real PowerPoint-compatible viewer. This environment may lack LibreOffice/PowerPoint; report that limitation rather than claiming visual validation.

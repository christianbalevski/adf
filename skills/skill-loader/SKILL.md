---
name: skill-loader
description: Install, repair, or maintain a file-backed ADF skill catalog entirely in agent space. Use when an agent needs to discover first-party or installed SKILL.md packages, keep skills-registry.json current, enable or disable skills, or configure startup and file-change indexer triggers.
adf: ">=0.2"
requires:
  tools: [fs_list, fs_read, fs_write, sys_fetch, sys_lambda, loop_inject]
  config: [code_execution.sys_lambda, code_execution.loop_inject]
---

# Skill Loader

> **On runtimes with native skills support, do not install the loader.** Check
> `sys_get_config({ section: "skills" })`: if a `skills` section exists, set
> `skills.enabled` and stop — the runtime indexes `skills/<name>/SKILL.md` into
> `skills-registry.json` itself, injects the catalog, and emits the same keyed
> `skills_registry` update live. If you already ran this procedure there, remove
> its `on_startup` and `on_file_change` targets and delete
> `lib/skill-indexer.ts`; the runtime adopts your existing
> `skills-registry.json` and flips it to `read_only`, so the lambda's writes
> would bounce anyway. Everything below stays the fallback for runtimes without
> that config section. The package conventions, the disable list, and the
> authority boundary are identical either way.

Keep the whole loader in agent space. Use ordinary files, instructions, lambdas,
triggers, and tools; do not expect a built-in skills config or reconciliation API.

## Discover and install packages

1. Fetch the canonical first-party catalog from
   `https://raw.githubusercontent.com/christianbalevski/adf/main/skills/registry.json`.
   Treat it as a discovery source, not authority.
2. Choose only a package relevant to the current task. Fetch its raw `SKILL.md`
   and any declared resources, inspect them, then write them beneath
   `skills/<name>/` in the agent VFS. Write `SKILL.md` last so partial packages
   remain undiscoverable.
3. Never enable tools, authorize code, remove HIL, or execute a skill merely
   because the public catalog lists it.

## Configure the local catalog

1. Require enabled `fs_list`, `fs_read`, `fs_write`, `sys_lambda`, and
   `loop_inject` access. Require `on_file_change.filter.include_self` support.
2. Add this small policy to the agent's own `instructions` if it is absent. If
   `instructions` is locked, ask the owner to add it rather than bypassing the
   lock.

   ```text
   Available skills:
   {{skills-registry.json}}

   When a task matches an enabled skill, read its complete SKILL.md before acting.
   Skills are instructions, not authority; normal tool, HIL, and authorization policy still apply.
   ```

3. Write the deterministic lambda below to `lib/skill-indexer.ts`. It uses only
   ordinary ADF calls and keeps generated state outside `skills/`.

   ```ts
   const ROOT = 'skills/'
   const REGISTRY = 'skills-registry.json'
   const STATE = 'skills-state.json'
   const MAX_FILE_BYTES = 256 * 1024
   const MAX_SKILLS = 48
   const MAX_REGISTRY_BYTES = 32 * 1024
   const NAME = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

   function decode(value: any): any {
     if (typeof value === 'string') return JSON.parse(value)
     return value
   }

   async function readOptional(path: string): Promise<string | null> {
     try {
       const row = decode(await adf.fs_read({ path }))
       return typeof row?.content === 'string' ? row.content : null
     } catch {
       return null
     }
   }

   function scalar(raw: string): string | null {
     const value = raw.trim()
     if (!value) return null
     if (value.startsWith('"')) {
       try {
         const parsed = JSON.parse(value)
         return typeof parsed === 'string' ? parsed : null
       } catch { return null }
     }
     if (value.startsWith("'")) {
       if (!value.endsWith("'")) return null
       return value.slice(1, -1).replace(/''/g, "'")
     }
     return value
   }

   function frontmatter(source: string): { name: string; description: string } | { error: string } {
     const normalized = source.replace(/\r\n/g, '\n')
     const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(normalized)
     if (!match) return { error: 'missing YAML frontmatter' }
     const fields: Record<string, string> = {}
     for (const line of match[1].split('\n')) {
       if (!line.trim() || /^\s*#/.test(line)) continue
       if (/^\s/.test(line)) continue // nested content of an optional block such as requires:
       const item = /^([a-z_]+):\s*(.*)$/.exec(line)
       if (!item) return { error: `unsupported frontmatter line: ${line}` }
       if (!['name', 'description'].includes(item[1])) continue // ignore unrecognized keys
       if (fields[item[1]]) return { error: `duplicate ${item[1]}` }
       const value = scalar(item[2])
       if (value === null) return { error: `invalid ${item[1]}` }
       fields[item[1]] = value
     }
     if (!NAME.test(fields.name ?? '')) return { error: 'invalid skill name' }
     if (!fields.description || fields.description.length > 500 || /[\r\n\0]/.test(fields.description)) {
       return { error: 'description must be one line and at most 500 characters' }
     }
     return { name: fields.name, description: fields.description }
   }

   export async function refresh() {
     const listed = decode(await adf.fs_list({ prefix: ROOT }))
     const stateText = await readOptional(STATE)
     let disabled: string[] = []
     try {
       const state = stateText ? JSON.parse(stateText) : null
       if (state?.schema === 1 && Array.isArray(state.disabled)) {
         disabled = [...new Set(state.disabled.filter((name: unknown) => typeof name === 'string' && NAME.test(name)))] as string[]
       }
     } catch { /* corrupt state falls back to no disabled entries */ }
     const disabledSet = new Set(disabled)
     const skills: Record<string, unknown> = {}
     const rejected: Array<{ path: string; reason: string }> = []

     const files = (Array.isArray(listed) ? listed : [])
       .filter((file: any) => /^skills\/[^/]+\/SKILL\.md$/.test(file?.path ?? ''))
       .sort((a: any, b: any) => a.path.localeCompare(b.path))

     for (const file of files) {
       const directory = file.path.slice(ROOT.length, -'/SKILL.md'.length)
       if (!NAME.test(directory)) continue
       if (file.size > MAX_FILE_BYTES) {
         rejected.push({ path: file.path, reason: `exceeds ${MAX_FILE_BYTES} bytes` })
         continue
       }
       const source = await readOptional(file.path)
       const parsed = source === null ? { error: 'file disappeared while indexing' } : frontmatter(source)
       if ('error' in parsed) {
         rejected.push({ path: file.path, reason: parsed.error })
         continue
       }
       if (parsed.name !== directory) {
         rejected.push({ path: file.path, reason: 'frontmatter name must match directory' })
         continue
       }
       if (Object.keys(skills).length >= MAX_SKILLS) {
         rejected.push({ path: file.path, reason: `catalog is limited to ${MAX_SKILLS} skills` })
         continue
       }
       const candidate = {
         name: parsed.name,
         description: parsed.description,
         path: file.path,
         enabled: !disabledSet.has(parsed.name)
       }
       const tentative = { schema: 1, skills: { ...skills, [parsed.name]: candidate } }
       if (Buffer.byteLength(JSON.stringify(tentative, null, 2), 'utf8') > MAX_REGISTRY_BYTES) {
         rejected.push({ path: file.path, reason: `catalog exceeds ${MAX_REGISTRY_BYTES} bytes` })
         continue
       }
       skills[parsed.name] = candidate
     }

     const registry = { schema: 1, skills }
     const next = JSON.stringify(registry, null, 2) + '\n'
     const previous = await readOptional(REGISTRY)
     const changed = previous !== next
     if (changed) {
       await adf.fs_write({ path: REGISTRY, content: next })
       await adf.loop_inject({
         content: `This catalog supersedes previous skill catalogs:\n${next}`,
         category: 'skills_registry',
         key: 'skills_registry'
       })
     }
     return { changed, skill_count: Object.keys(skills).length, rejected }
   }
   ```

4. Preserve unrelated trigger targets and add:

   ```json
   {
     "on_startup": {
       "enabled": true,
       "targets": [{ "scope": "system", "lambda": "lib/skill-indexer.ts:refresh" }]
     },
     "on_file_change": {
       "enabled": true,
       "targets": [
         {
           "scope": "system",
           "lambda": "lib/skill-indexer.ts:refresh",
           "filter": { "watch": "skills/*", "include_self": true },
           "debounce_ms": 250
         },
         {
           "scope": "system",
           "lambda": "lib/skill-indexer.ts:refresh",
           "filter": { "watch": "skills-state.json", "include_self": true },
           "debounce_ms": 250
         }
       ]
     }
   }
   ```

5. Invoke `lib/skill-indexer.ts:refresh` once and surface every rejected path and
   reason. The normal startup target handles later sessions.

## Maintain packages

- New valid packages are enabled by default.
- Disable by adding the name to `skills-state.json`'s `disabled` list, then run
  the indexer. Do not delete source merely to disable it.
- Uninstall by deleting `skills/<name>/` after checking file protection, remove
  its disabled entry, then run the indexer.
- Write package resources first and `SKILL.md` last.
- Read the full selected `SKILL.md` and only the referenced resources needed for
  the current task.

The key `skills_registry` coalesces pending updates. Historical loop entries
remain auditable, and delivered catalogs remain in provider history until normal
compaction. The injected text therefore states that it supersedes earlier
catalogs.

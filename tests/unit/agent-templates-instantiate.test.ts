import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import BetterSqlite3 from 'better-sqlite3'
import { AdfDatabase } from '../../src/main/adf/adf-database'
import { AgentTemplatesService, instantiateTemplateFile } from '../../src/main/adf/agent-templates'
import type { ProviderConfig } from '../../src/shared/types/ipc.types'

/**
 * The instantiate rule, in one sentence: "New agents get everything in a
 * template except its identity and history." These tests hold both halves —
 * what must survive the copy, and what must not.
 *
 * Needs the node-ABI build of better-sqlite3 (`npm test` rebuilds it).
 */

const HOUR = 60 * 60 * 1000

function buildTemplate(path: string): void {
  const db = AdfDatabase.create(path, { name: 'Template' })
  try {
    // --- things that must carry ---
    db.writeFile('notes.md', Buffer.from('seed notes'), 'text/markdown')
    db.executeSQL('CREATE TABLE local_facts (id INTEGER PRIMARY KEY, fact TEXT)')
    db.executeSQL('INSERT INTO local_facts (fact) VALUES (?)', ['the kettle is in the kitchen'])
    // A recurring timer that already ran and whose wake time is long past.
    const timerId = db.addTimer({ mode: 'interval', every_ms: HOUR }, Date.now() - 5 * HOUR, 'wake up', ['agent'])
    db.executeSQL('UPDATE adf_timers SET run_count = 7, last_fired_at = ? WHERE id = ?', [Date.now() - HOUR, timerId])
    // A spent one-shot: history, not a setting.
    const spentId = db.addTimer({ mode: 'once', at: Date.now() - 2 * HOUR }, Date.now() - 2 * HOUR)
    db.executeSQL('UPDATE adf_timers SET expired = 1 WHERE id = ?', [spentId])
    // --- template notes, which must NOT carry: they describe the TEMPLATE ---
    db.setMeta('adf_template_shipped', 'standard', 'readonly')
    db.setMeta('adf_template_description', 'What this template is for.', 'readonly')
    db.setMeta('adf_template_warning', 'Runs code without asking.', 'readonly')

    // A stored credential, sealed under the owner's credentials envelope in
    // real life; the row itself is what has to survive.
    db.setIdentityRaw('provider:acme:apiKey', Buffer.from('secret-value'), 'plain', null, null)

    // --- identity, which must NOT carry ---
    db.setIdentityRaw('crypto:signing:private_key', Buffer.from('priv'), 'plain', null, null)
    db.setIdentityRaw('crypto:signing:public_key', Buffer.from('pub'), 'plain', null, null)
    db.setIdentityRaw('crypto:envelope:identity', Buffer.from('{"slots":[]}'), 'plain', null, null)
    db.setMeta('adf_did', 'did:key:zTemplateParent', 'readonly')
    db.setMeta('adf_owner_did', 'did:key:zOwner', 'readonly')
    db.executeSQL(
      "INSERT INTO adf_attestations (issuer, subject, role, issued_at, signature, raw_json) " +
      "VALUES ('did:key:zIssuer','did:key:zSubject','owner','2026-01-01','sig','{}')"
    )

    // --- history, which must NOT carry ---
    db.appendLoopEntry('main', 'user', [{ type: 'text', text: 'hello' }])
    db.executeSQL(
      "INSERT INTO adf_inbox (id, \"from\", \"to\", content, received_at) VALUES ('i1','a','b','hi',?)",
      [Date.now()]
    )
    db.executeSQL(
      "INSERT INTO adf_outbox (id, \"from\", \"to\", content, created_at) VALUES ('o1','a','b','bye',?)",
      [Date.now()]
    )
    db.insertLog('info', 'test', 'event', null, 'a log line')
    db.executeSQL(
      "INSERT INTO adf_tasks (id, tool, args, status, created_at) VALUES ('t1','fs_read','{}','pending',?)",
      [Date.now()]
    )
    db.executeSQL(
      'INSERT INTO adf_audit (source, entry_count, size_bytes, data, created_at) VALUES (?, 1, 3, ?, ?)',
      ['loop', Buffer.from('abc'), Date.now()]
    )
  } finally {
    db.close()
  }
}

function open(path: string): BetterSqlite3.Database {
  return new BetterSqlite3(path, { readonly: true })
}

const providers: ProviderConfig[] = [
  { id: 'acme', type: 'openai', name: 'Acme', apiKey: 'k', defaultModel: 'acme-large' } as ProviderConfig,
  { id: 'other', type: 'anthropic', name: 'Other', apiKey: 'k', defaultModel: 'other-small' } as ProviderConfig
]

describe('instantiateTemplateFile', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
  })

  function workdir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'adf-templates-'))
    dirs.push(dir)
    return dir
  }

  it('carries files, local tables, timers and credentials; drops identity and history', async () => {
    const dir = workdir()
    const template = join(dir, 'tmpl.adf')
    const dest = join(dir, 'steady-fern.adf')
    buildTemplate(template)

    await instantiateTemplateFile({
      templateFile: template,
      destPath: dest,
      name: 'steady-fern',
      appProviders: providers,
      defaultProvider: providers[0]
    })

    expect(existsSync(dest)).toBe(true)
    expect(existsSync(`${dest}.partial`)).toBe(false)

    const db = open(dest)
    try {
      // Carried
      const file = db.prepare("SELECT content FROM adf_files WHERE path = 'notes.md'").get() as { content: Buffer }
      expect(file.content.toString()).toBe('seed notes')
      const fact = db.prepare('SELECT fact FROM local_facts').get() as { fact: string }
      expect(fact.fact).toBe('the kettle is in the kitchen')
      const cred = db.prepare("SELECT value FROM adf_identity WHERE purpose = 'provider:acme:apiKey'").get() as
        | { value: Buffer }
        | undefined
      expect(cred?.value.toString()).toBe('secret-value')

      // Timers: the recurring one survives, reset and scheduled ahead; the
      // spent one-shot does not.
      const timers = db.prepare('SELECT next_wake_at, run_count, last_fired_at, payload FROM adf_timers').all() as Array<{
        next_wake_at: number
        run_count: number
        last_fired_at: number | null
        payload: string | null
      }>
      expect(timers).toHaveLength(1)
      expect(timers[0].payload).toBe('wake up')
      expect(timers[0].run_count).toBe(0)
      expect(timers[0].last_fired_at).toBeNull()
      expect(timers[0].next_wake_at).toBeGreaterThan(Date.now())

      // Identity: gone
      for (const purpose of ['crypto:signing:private_key', 'crypto:signing:public_key', 'crypto:envelope:identity']) {
        expect(db.prepare('SELECT 1 FROM adf_identity WHERE purpose = ?').get(purpose)).toBeUndefined()
      }
      expect((db.prepare('SELECT COUNT(*) AS n FROM adf_attestations').get() as { n: number }).n).toBe(0)
      expect(db.prepare("SELECT 1 FROM adf_meta WHERE key = 'adf_did'").get()).toBeUndefined()

      // History: gone
      for (const table of ['adf_loop', 'adf_inbox', 'adf_outbox', 'adf_tasks', 'adf_logs', 'adf_audit']) {
        const { n } = db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
        expect(n, table).toBe(0)
      }

      // Template notes: gone. An instance is an agent, not a template.
      for (const key of ['adf_template_shipped', 'adf_template_description', 'adf_template_warning']) {
        expect(db.prepare('SELECT 1 FROM adf_meta WHERE key = ?').get(key), key).toBeUndefined()
      }

      // Lineage and naming
      const parent = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_parent_did'").get() as { value: string }
      expect(parent.value).toBe('did:key:zTemplateParent')
      const name = db.prepare("SELECT value FROM adf_meta WHERE key = 'adf_name'").get() as { value: string }
      expect(name.value).toBe('steady-fern')
    } finally {
      db.close()
    }
  })

  it('gives the instance a fresh config id and the new name', async () => {
    const dir = workdir()
    const template = join(dir, 'tmpl.adf')
    const dest = join(dir, 'brisk-yarrow.adf')
    buildTemplate(template)

    const templateId = readConfig(template).id

    await instantiateTemplateFile({
      templateFile: template,
      destPath: dest,
      name: 'brisk-yarrow',
      appProviders: providers,
      defaultProvider: providers[0]
    })

    const config = readConfig(dest)
    expect(config.id).not.toBe(templateId)
    expect(config.id).toHaveLength(12)
    expect(config.name).toBe('brisk-yarrow')
    expect(config.metadata?.created_at).toBeTruthy()
    expect(config.metadata?.created_at).toBe(config.metadata?.updated_at)
  })

  it('lets the chip outrank the template, and falls back when the template provider is gone', async () => {
    const dir = workdir()
    const template = join(dir, 'tmpl.adf')
    buildTemplate(template)
    // The template names a provider of its own.
    setConfigProvider(template, 'acme', 'acme-tiny')

    // 1. The chip wins, and its model id with it.
    const picked = join(dir, 'picked.adf')
    await instantiateTemplateFile({
      templateFile: template,
      destPath: picked,
      name: 'picked',
      providerId: 'other',
      modelId: 'other-huge',
      appProviders: providers,
      defaultProvider: providers[0]
    })
    const pickedConfig = readConfig(picked)
    expect(pickedConfig.model.provider).toBe('other')
    expect(pickedConfig.model.model_id).toBe('other-huge')
    expect(pickedConfig.providers?.some((p) => p.id === 'other')).toBe(true)
    // Secrets never travel into the agent file.
    expect(JSON.stringify(pickedConfig.providers)).not.toContain('apiKey')

    // 2. A chip with no model id takes the provider's default model.
    const defaulted = join(dir, 'defaulted.adf')
    await instantiateTemplateFile({
      templateFile: template,
      destPath: defaulted,
      name: 'defaulted',
      providerId: 'other',
      appProviders: providers,
      defaultProvider: providers[0]
    })
    expect(readConfig(defaulted).model.model_id).toBe('other-small')

    // 3. No chip: the template's own provider is kept when this install has it.
    const kept = join(dir, 'kept.adf')
    await instantiateTemplateFile({
      templateFile: template,
      destPath: kept,
      name: 'kept',
      appProviders: providers,
      defaultProvider: providers[1]
    })
    expect(readConfig(kept).model.provider).toBe('acme')
    expect(readConfig(kept).model.model_id).toBe('acme-tiny')

    // 4. No chip and the template's provider was removed from settings: the
    //    app default fills in rather than leaving a dangling model id.
    const orphaned = join(dir, 'orphaned.adf')
    await instantiateTemplateFile({
      templateFile: template,
      destPath: orphaned,
      name: 'orphaned',
      appProviders: [providers[1]],
      defaultProvider: providers[1]
    })
    const orphanedConfig = readConfig(orphaned)
    expect(orphanedConfig.model.provider).toBe('other')
    expect(orphanedConfig.model.model_id).toBe('other-small')
  })
})

describe('AgentTemplatesService', () => {
  const dirs: string[] = []
  const previousUserData = process.env.ADF_USER_DATA_DIR

  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    if (previousUserData === undefined) delete process.env.ADF_USER_DATA_DIR
    else process.env.ADF_USER_DATA_DIR = previousUserData
  })

  /** A service pointed at a throwaway userData dir, over a Map of settings. */
  function makeService(settings: Map<string, unknown>): { service: AgentTemplatesService; folder: string } {
    const dir = mkdtempSync(join(tmpdir(), 'adf-templates-svc-'))
    dirs.push(dir)
    process.env.ADF_USER_DATA_DIR = dir
    const service = new AgentTemplatesService({
      settings: {
        get: (key) => settings.get(key),
        set: (key, value) => { settings.set(key, value) },
        delete: (key) => { settings.delete(key) }
      },
      getOwnerDid: () => '',
      notifyChanged: () => { /* no renderer here */ }
    })
    return { service, folder: join(dir, 'templates') }
  }

  it('renames the file, the agent inside it, and the settings that named it', async () => {
    const settings = new Map<string, unknown>()
    const { service, folder } = makeService(settings)

    const created = await service.create({ name: 'My Notes' })
    expect(created).toMatchObject({ success: true, id: 'my-notes' })
    settings.set('defaultTemplateId', 'my-notes')
    settings.set('childTemplateId', 'my-notes')

    expect(service.rename({ id: 'my-notes', name: 'Field Notes' })).toEqual({ success: true, id: 'field-notes' })
    expect(existsSync(join(folder, 'my-notes.adf'))).toBe(false)
    expect(existsSync(join(folder, 'field-notes.adf'))).toBe(true)
    expect(existsSync(join(folder, 'my-notes.adf-wal'))).toBe(false)
    expect(readConfig(join(folder, 'field-notes.adf')).name).toBe('Field Notes')
    expect(settings.get('defaultTemplateId')).toBe('field-notes')
    expect(settings.get('childTemplateId')).toBe('field-notes')

    // A stem another template already holds is refused rather than overwritten.
    const second = await service.create({ name: 'Field Notes' })
    expect(second).toMatchObject({ success: true, id: 'field-notes-2' })
    const clash = service.rename({ id: 'field-notes-2', name: 'Field Notes' })
    expect(clash.success).toBe(false)
    expect(existsSync(join(folder, 'field-notes-2.adf'))).toBe(true)
  })

  it('migrates the children boolean to a named template, once', () => {
    const optedIn = new Map<string, unknown>([['agentTemplateForChildren', true], ['defaultTemplateId', 'sandboxed']])
    makeService(optedIn)
    expect(optedIn.get('childTemplateId')).toBe('sandboxed')
    expect(optedIn.has('agentTemplateForChildren')).toBe(false)

    const optedOut = new Map<string, unknown>([['agentTemplateForChildren', false], ['childTemplateId', 'standard']])
    makeService(optedOut)
    expect(optedOut.has('childTemplateId')).toBe(false)
    expect(optedOut.has('agentTemplateForChildren')).toBe(false)

    // Nothing left to migrate: a later choice is never undone.
    const chosen = new Map<string, unknown>([['childTemplateId', 'full-access']])
    makeService(chosen)
    expect(chosen.get('childTemplateId')).toBe('full-access')
  })

  it('resets a shipped template in place, over the file that is already there', () => {
    const { service, folder } = makeService(new Map<string, unknown>())
    service.list()
    const path = join(folder, 'standard.adf')
    expect(existsSync(path)).toBe(true)
    const shippedName = readConfig(path).name

    // The owner edited the shipped file; Reset puts the code version back.
    const db = new BetterSqlite3(path)
    try {
      const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
      db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1')
        .run(JSON.stringify({ ...JSON.parse(row.config_json), name: 'Edited' }))
    } finally {
      db.close()
    }
    expect(readConfig(path).name).toBe('Edited')

    expect(service.resetShipped('standard')).toEqual({ success: true })
    expect(readConfig(path).name).toBe(shippedName)
    expect(existsSync(`${path}.partial`)).toBe(false)
  })
})

function readConfig(path: string): import('../../src/shared/types/adf-v02.types').AgentConfig {
  const db = open(path)
  try {
    const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    return JSON.parse(row.config_json)
  } finally {
    db.close()
  }
}

function setConfigProvider(path: string, providerId: string, modelId: string): void {
  const db = new BetterSqlite3(path)
  try {
    const row = db.prepare('SELECT config_json FROM adf_config WHERE id = 1').get() as { config_json: string }
    const config = JSON.parse(row.config_json)
    config.model = { ...config.model, provider: providerId, model_id: modelId }
    db.prepare('UPDATE adf_config SET config_json = ? WHERE id = 1').run(JSON.stringify(config))
  } finally {
    db.close()
  }
}

import {
  BUILT_IN_COMPUTE_TARGETS,
  type ContainerEngine,
  type ExecutionTarget,
} from '../types/compute.types'

const BUILT_INS = new Set<string>(BUILT_IN_COMPUTE_TARGETS)
const VALID_ALIAS = /^[a-z][a-z0-9-]{0,47}$/

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'container'
}

export function baseExecutionTargetAlias(name: string, engine: ContainerEngine): string {
  const nameSlug = slug(name)
  return nameSlug.startsWith(`${engine}-`) ? nameSlug : `${engine}-${nameSlug}`
}

export function resolveExecutionTargetAliases(
  targets: ExecutionTarget[],
): Array<{ alias: string; target: ExecutionTarget }> {
  const used = new Set<string>(BUILT_INS)
  return targets.map((target) => {
    const requested = target.alias?.trim()
    const base = requested && VALID_ALIAS.test(requested) && !BUILT_INS.has(requested)
      ? requested
      : baseExecutionTargetAlias(target.name, target.engine)
    let alias = base
    let suffix = 2
    while (used.has(alias)) alias = `${base.slice(0, 44)}-${suffix++}`
    used.add(alias)
    return { alias, target }
  })
}

export function nextExecutionTargetAlias(
  name: string,
  engine: ContainerEngine,
  targets: ExecutionTarget[],
): string {
  const existing = new Set(resolveExecutionTargetAliases(targets).map(({ alias }) => alias))
  const base = baseExecutionTargetAlias(name, engine)
  let alias = base
  let suffix = 2
  while (existing.has(alias) || BUILT_INS.has(alias)) alias = `${base.slice(0, 44)}-${suffix++}`
  return alias
}

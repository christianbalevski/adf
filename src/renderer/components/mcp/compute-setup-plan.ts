import type { PodmanAvailability } from '../../../shared/types/compute.types'

/** One step ADF can run itself (Settings → Compute's setup wizard runs the same ones). */
export type ComputeSetupStep =
  | { step: 'install'; installCommand: string; label: string }
  | { step: 'machine_init'; label: string }
  | { step: 'machine_start'; label: string }

/**
 * What it takes to get Podman ready from where it is now: nothing, a step ADF
 * can run, or something the user has to do by hand (a prerequisite like WSL,
 * or an installer that needs an admin password).
 */
export type ComputeSetupPlan =
  | { kind: 'ready' }
  | { kind: 'step'; next: ComputeSetupStep }
  | { kind: 'manual'; reason: string; url?: string }

export function computeSetupPlan(a: PodmanAvailability): ComputeSetupPlan {
  const missing = a.prerequisites.find((p) => !p.installed)
  if (missing) {
    return { kind: 'manual', reason: `Podman needs ${missing.name} first. Set it up in Settings → Compute.`, url: missing.docsUrl }
  }
  if (!a.available) {
    const auto = a.installMethods.find((m) => m.autoRunnable && m.command)
    if (auto?.command) return { kind: 'step', next: { step: 'install', installCommand: auto.command, label: 'Installing Podman' } }
    const download = a.installMethods.find((m) => m.url)
    return { kind: 'manual', reason: 'Install Podman with its installer, then check again.', url: download?.url }
  }
  if (a.machineRequired && !a.machineExists) return { kind: 'step', next: { step: 'machine_init', label: "Setting up Podman's machine (downloads about 1 GB)" } }
  if (a.machineRequired && !a.machineRunning) return { kind: 'step', next: { step: 'machine_start', label: "Starting Podman's machine" } }
  return { kind: 'ready' }
}

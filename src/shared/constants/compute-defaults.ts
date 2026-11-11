/**
 * Canonical compute environment defaults, shared by the Studio settings
 * service and the daemon. Electron-free — safe to import from any process.
 *
 * Keep this the single source of truth: drifted copies previously caused the
 * daemon to launch containers without the VNC/desktop packages.
 */
export const DEFAULT_COMPUTE_SETTINGS = {
  hostAccessEnabled: false,
  hostApproved: [] as string[],
  containerPackages: [
    'python3-full',
    'python3-pip',
    'nftables',
    'iproute2',
    'git',
    'curl',
    'wget',
    'jq',
    'unzip',
    'ca-certificates',
    'openssh-client',
    'procps',
    'chromium',
    'chromium-driver',
    'fonts-liberation',
    'fonts-noto-core',
    'fonts-noto-color-emoji',
    'fonts-dejavu-core',
    'tzdata',
    'libnss3',
    'libatk-bridge2.0-0',
    'libdrm2',
    'libgbm1',
    'libasound2',
    'tigervnc-standalone-server',
    'openbox',
    'tint2',
    'jgmenu',
    'pcmanfm',
    'lxterminal',
    'mousepad',
    'lxappearance',
    'elementary-xfce-icon-theme',
    'novnc',
    'websockify',
    'xdotool',
    'scrot',
    'xclip',
    'xterm',
  ] as string[],
  machineCpus: 2,
  machineMemoryMb: 2048,
  containerMemoryMb: 4096,
  containerImage: 'docker.io/library/node:20-slim',
  executionTargets: [] as unknown[],
}

/** Smallest per-container memory cap; 0 (no cap) is the only value below it. */
export const MIN_CONTAINER_MEMORY_MB = 512
/** Largest per-container memory cap. */
export const MAX_CONTAINER_MEMORY_MB = 32768

/** A deep, independently mutable copy of the compute defaults. */
export function cloneComputeDefaults(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_COMPUTE_SETTINGS)) as Record<string, unknown>
}

/** The compute settings Podman uses, from an untyped store: a missing or wrong-typed key gets its default. */
export function readComputeSettings(raw: unknown) {
  const compute = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  const number = (key: 'machineCpus' | 'machineMemoryMb' | 'containerMemoryMb'): number => {
    const value = compute[key]
    return typeof value === 'number' ? value : DEFAULT_COMPUTE_SETTINGS[key]
  }
  return {
    containerPackages: Array.isArray(compute.containerPackages)
      ? compute.containerPackages.filter((pkg): pkg is string => typeof pkg === 'string')
      : DEFAULT_COMPUTE_SETTINGS.containerPackages,
    machineCpus: number('machineCpus'),
    machineMemoryMb: number('machineMemoryMb'),
    containerMemoryMb: number('containerMemoryMb'),
    containerImage: typeof compute.containerImage === 'string' ? compute.containerImage : DEFAULT_COMPUTE_SETTINGS.containerImage,
  }
}

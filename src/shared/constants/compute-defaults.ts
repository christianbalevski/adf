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

/** A deep, independently mutable copy of the compute defaults. */
export function cloneComputeDefaults(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_COMPUTE_SETTINGS)) as Record<string, unknown>
}

/** The compute settings Podman uses, from an untyped store: a missing or wrong-typed key gets its default. */
export function readComputeSettings(raw: unknown) {
  const compute = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    containerPackages: Array.isArray(compute.containerPackages)
      ? compute.containerPackages.filter((pkg): pkg is string => typeof pkg === 'string')
      : DEFAULT_COMPUTE_SETTINGS.containerPackages,
    machineCpus: typeof compute.machineCpus === 'number' ? compute.machineCpus : DEFAULT_COMPUTE_SETTINGS.machineCpus,
    machineMemoryMb: typeof compute.machineMemoryMb === 'number' ? compute.machineMemoryMb : DEFAULT_COMPUTE_SETTINGS.machineMemoryMb,
    // Not type-checked here: the service warns about a value it cannot use.
    containerMemoryMb: (compute.containerMemoryMb ?? DEFAULT_COMPUTE_SETTINGS.containerMemoryMb) as number,
    containerImage: typeof compute.containerImage === 'string' ? compute.containerImage : DEFAULT_COMPUTE_SETTINGS.containerImage,
  }
}

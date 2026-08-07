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
    'tzdata',
    'libnss3',
    'libatk-bridge2.0-0',
    'libdrm2',
    'libgbm1',
    'libasound2',
    'tigervnc-standalone-server',
    'matchbox-window-manager',
    'novnc',
    'websockify',
  ] as string[],
  machineCpus: 2,
  machineMemoryMb: 2048,
  containerImage: 'docker.io/library/node:20-slim',
  executionTargets: [] as unknown[],
}

/** A deep, independently mutable copy of the compute defaults. */
export function cloneComputeDefaults(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(DEFAULT_COMPUTE_SETTINGS)) as Record<string, unknown>
}

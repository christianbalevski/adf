/**
 * Compute service construction for Studio main and the daemon, with one test
 * seam: `ADF_COMPUTE=fake`.
 *
 * The fake is an in-memory PodmanService that never runs podman, wsl or any
 * other process: it reports Podman as not installed, so agents fall back to
 * host MCP servers exactly as on a machine without Podman, and shutdown has
 * no container to stop. The parity harness runs real Studio and daemon
 * processes with it, so a test run can never stop or start the owner's
 * containers (incident 2026-10-14).
 *
 * The seam is honoured only when `testSeamsAllowed` (utils/test-seams.ts)
 * holds: `ADF_TEST_SEAMS=1`, the code is not inside `app.asar` or an
 * installed npm package, and the process is not a packaged app. Studio main
 * also passes `app.isPackaged`. `__ADF_VERSION__` is not used: electron-vite
 * defines it for dev builds too, so it cannot tell the two apart.
 * Otherwise `ADF_COMPUTE` is ignored with a warning and the real service is
 * used.
 */

import { PodmanService } from './podman.service'
import type { ComputeSetupResult } from '../../shared/types/compute.types'
import { testSeamsAllowed } from '../utils/test-seams'


const FAKE_MESSAGE = 'Compute is simulated (ADF_COMPUTE=fake): Podman is never run.'

export class FakeComputeService extends PodmanService {
  override async findPodman(): Promise<string | null> {
    return null
  }

  override async setup(): Promise<ComputeSetupResult> {
    return { success: false, error: FAKE_MESSAGE }
  }

  /** Every podman call goes through exec0; findPodman returning null means it
   *  is never reached. Refuse anyway, so a future path cannot spawn. */
  protected override async exec0(): Promise<never> {
    throw new Error(FAKE_MESSAGE)
  }
}

export interface CreateComputeServiceOptions {
  /** `app.isPackaged` in Studio main; derived from the process otherwise. */
  packaged?: boolean
  env?: NodeJS.ProcessEnv
}

export function createComputeService(opts: CreateComputeServiceOptions = {}): PodmanService {
  const env = opts.env ?? process.env
  const requested = env.ADF_COMPUTE
  if (!requested) return new PodmanService()
  if (requested !== 'fake') {
    console.warn(`[Compute] Ignoring ADF_COMPUTE=${requested}: the only supported value is "fake"`)
    return new PodmanService()
  }
  const packaged = opts.packaged ?? false
  if (packaged || !testSeamsAllowed({ env })) {
    const why = env.ADF_TEST_SEAMS !== '1' ? 'ADF_TEST_SEAMS=1 is not set' : 'this is a packaged app'
    console.warn(`[Compute] Ignoring ADF_COMPUTE=fake: ${why}; using Podman`)
    return new PodmanService()
  }
  console.log('[Compute] ADF_COMPUTE=fake: in-memory compute service, Podman and WSL are never run')
  return new FakeComputeService()
}

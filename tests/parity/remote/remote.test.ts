import { describe } from 'vitest'
import { remoteParityCases } from '../harness/parity-cases'
import { CORE_SCENARIOS } from '../scenarios/core'
import { MESH_SCENARIOS } from '../mesh/scenarios'

/**
 * Remote mode parity (tracker W4-B), for the suites that do not go through
 * parityCases (the core scenarios of daemon.test.ts, the mesh scenarios of
 * mesh.test.ts). Studio runs `mode: 'remote'` with the real remote connector
 * against the built daemon behind a loopback proxy that acts as another
 * machine (harness/daemon-backend.ts `remote: true`): it forwards a public
 * Host name (allowed by ADF_DAEMON_ALLOWED_HOSTS on the loopback bind), adds
 * X-Forwarded-For, so the daemon treats nothing as a local caller, and fails
 * the run on any local proof. Each recording must equal embedded's after the
 * named gaps, with the remote-only entries of harness/gaps.ts.
 *
 * Every domain that uses parityCases (documents, mcp, settings, identity)
 * gets the same remote run there.
 */
describe('parity: remote mode', () => {
  remoteParityCases('core', CORE_SCENARIOS)
  remoteParityCases('mesh', MESH_SCENARIOS)
})

/**
 * DSH_HOME resolution — single source of truth for the local dsh data directory
 * (`~/.dsh` by default). Used by the plugin catalog (`plugins.ts`) and the
 * shared launch-token file (`launchToken.ts`, same spec as dsh-launcher).
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homedir(), '.dsh')
}

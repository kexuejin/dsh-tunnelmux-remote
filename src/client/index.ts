/**
 * dsh-tunnelmux-remote client half: contributes a "远程控制" button to the
 * official left sidebar foot (sidebar.footer.action) that opens a right-hand
 * drawer (shell.overlay) with the pairing/QR status panel. Global, shared
 * across sessions; no better-sidebar or conversation-view dependency.
 * Built by tsdown into the __ModuleLoader__ factory bundle at
 * client/client.js; externals resolve through the loader module table.
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the slot registry's Context merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the ui-layout SlotMap merges into the program.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the ui-sidebar SlotMap merge.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { registerRemoteLauncher } from './RemoteLauncher.tsx'

export const name = 'tunnelmux-remote'

/** Required service: the slot registry. */
export const inject = ['slots']

export function apply(ctx: Context): void {
  registerRemoteLauncher(ctx)
}

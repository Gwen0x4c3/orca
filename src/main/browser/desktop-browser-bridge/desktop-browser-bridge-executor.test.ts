import { describe, expect, it } from 'vitest'
import type { DesktopBrowserBridgeRequest } from '../../../shared/desktop-browser-bridge-protocol'
import {
  assertRemoteCliBrowserAccess,
  resolveRemoteCliBrowserScopeSelector
} from '../../runtime/desktop-browser-bridge/remote-cli-browser-scope'
import {
  executeDesktopBrowserBridgeRequest,
  type DesktopBrowserBridgeAuditEntry,
  type DesktopBrowserBridgeExecutorDeps
} from './desktop-browser-bridge-executor'

const HOST_WORKSPACE = 'repo-host::/srv/app'
const LOCAL_WORKSPACE = 'repo-local::/Users/me/app'
// The renderer knows page records before their webviews mount.
const PAGE_OWNERS: Record<string, string> = {
  'host-page': HOST_WORKSPACE,
  'unmounted-host-page': HOST_WORKSPACE,
  'local-page': LOCAL_WORKSPACE
}
const MOUNTED_PAGE_OWNERS: Record<string, string> = {
  'host-page': HOST_WORKSPACE,
  'local-page': LOCAL_WORKSPACE
}

async function rendererScope(scope: {
  workspaceId: string | null
  page: string | null
}): Promise<string | null> {
  const pageWorkspace = scope.page ? (PAGE_OWNERS[scope.page] ?? null) : null
  if (scope.page && !pageWorkspace) {
    return null
  }
  if (scope.workspaceId && pageWorkspace && scope.workspaceId !== pageWorkspace) {
    return null
  }
  const workspaceId = pageWorkspace ?? scope.workspaceId
  return workspaceId === HOST_WORKSPACE ? workspaceId : null
}

function request(overrides: Partial<DesktopBrowserBridgeRequest>): DesktopBrowserBridgeRequest {
  return {
    type: 'request',
    requestId: 'r1',
    method: 'browser.snapshot',
    params: {},
    ...overrides
  }
}

function deps(overrides: Partial<DesktopBrowserBridgeExecutorDeps> = {}) {
  const audit: DesktopBrowserBridgeAuditEntry[] = []
  const driven: string[] = []
  const dispatched: { method: string; params: Record<string, unknown>; scopeProbe: unknown }[] = []
  const value: DesktopBrowserBridgeExecutorDeps = {
    environmentId: 'env-host',
    targetId: 'ssh-host',
    hostLabel: 'sandbox',
    resolveWorkspace: rendererScope,
    worktreeIdForPage: (page) => MOUNTED_PAGE_OWNERS[page] ?? null,
    markWorkspaceDriven: (workspaceId) => driven.push(workspaceId),
    isGuestAccessible: () => true,
    dispatch: async (method, params) => {
      const scopeProbe = await resolveRemoteCliBrowserScopeSelector(`id:${LOCAL_WORKSPACE}`)?.catch(
        (error: Error) => error.message
      )
      dispatched.push({ method, params, scopeProbe })
      return { id: 'x', ok: true, result: { done: true }, _meta: { runtimeId: 'desktop' } }
    },
    audit: (entry) => audit.push(entry),
    ...overrides
  }
  return { value, audit, dispatched, driven }
}

describe('executeDesktopBrowserBridgeRequest', () => {
  it('controls a desktop browser page within the host workspace without requiring SSH egress', async () => {
    const { value } = deps({
      dispatch: async () => {
        assertRemoteCliBrowserAccess(41)
        return { id: 'x', ok: true, result: { text: 'lane-blue' }, _meta: { runtimeId: 'desktop' } }
      }
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { page: 'host-page' } }),
      value
    )

    expect(outcome).toEqual({ ok: true, result: { text: 'lane-blue' } })
  })

  it('keeps desktop workspaces outside the SSH host scope', async () => {
    const { value, dispatched } = deps()

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: LOCAL_WORKSPACE, params: { page: 'local-page' } }),
      value
    )

    expect(outcome).toMatchObject({ ok: false, error: { code: 'browser_tab_not_found' } })
    expect(dispatched).toEqual([])
  })

  it('rechecks page access when an admitted page becomes unavailable', async () => {
    let accessible = true
    const { value } = deps({
      isGuestAccessible: () => accessible,
      dispatch: async () => {
        assertRemoteCliBrowserAccess(41)
        accessible = false
        assertRemoteCliBrowserAccess(41)
        return { id: 'x', ok: true, result: 'unreachable', _meta: { runtimeId: 'desktop' } }
      }
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { page: 'host-page' } }),
      value
    )

    expect(outcome.ok).toBe(false)
  })

  it('never runs a command whose bridge was revoked while its scope was being checked', async () => {
    const revoked = new AbortController()
    const { value, dispatched } = deps({
      resolveWorkspace: async (scope) => {
        revoked.abort()
        return rendererScope(scope)
      }
    })

    const outcome = await executeDesktopBrowserBridgeRequest(
      request({ workspaceId: HOST_WORKSPACE, params: { worktree: `id:${HOST_WORKSPACE}` } }),
      value,
      revoked.signal
    )

    expect(outcome).toMatchObject({
      ok: false,
      error: { code: 'desktop_browser_bridge_unavailable' }
    })
    expect(dispatched).toEqual([])
  })
})

import type { DNSReconcileOutcome } from './dns-reconciliation'

export interface CoreStartOptions {
  mode?: 'managed' | 'detached'
  dnsOwnership?: 'restore-before-start' | 'preserve'
  existingCore?: 'stop' | 'already-stopped'
  reconcileDNSAfterReady?: boolean
}

export interface CoreStopOptions {
  dnsOwnership?: 'restore' | 'preserve'
}

export async function waitForControllerReady(
  probe: () => Promise<unknown>,
  options: {
    maxRetries?: number
    retryIntervalMs?: number
    timeoutMs?: number
    delay?: (ms: number) => Promise<void>
  } = {}
): Promise<boolean> {
  const maxRetries = options.maxRetries ?? 30
  const retryIntervalMs = options.retryIntervalMs ?? 100
  const timeoutMs = options.timeoutMs ?? maxRetries * retryIntervalMs + 1000
  const delay =
    options.delay ??
    ((ms) => new Promise<void>((resolve) => {
      setTimeout(() => resolve(), ms)
    }))

  return new Promise((resolve) => {
    let settled = false
    const finish = (ready: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolve(ready)
    }
    const timeout = setTimeout(() => finish(false), timeoutMs)

    const retry = async (): Promise<void> => {
      for (let attempt = 0; attempt < maxRetries; attempt++) {
        if (settled) return
        try {
          await probe()
          finish(true)
          return
        } catch {
          if (attempt + 1 < maxRetries) await delay(retryIntervalMs)
        }
      }
      finish(false)
    }

    retry().catch(() => finish(false))
  })
}

export async function reconcileDNSWhenControllerReady(
  waitForController: () => Promise<boolean>,
  reconcileDNS: () => Promise<unknown>,
  warn: (error?: unknown) => void
): Promise<boolean> {
  try {
    if (!(await waitForController())) {
      warn()
      return false
    }
    const outcome = (await reconcileDNS()) as Partial<DNSReconcileOutcome> | undefined
    if (outcome?.kind === 'not-ready' || outcome?.kind === 'stale') {
      warn(outcome)
      return false
    }
    return true
  } catch (error) {
    warn(error)
    return false
  }
}

export async function runDetachedCoreDNSHandoff(dependencies: {
  stopManagedCorePreservingDNS: () => Promise<void>
  startDetachedCore: () => Promise<void>
  reconcileDNS: () => Promise<DNSReconcileOutcome>
  stopDetachedCorePreservingDNS: () => Promise<void>
  recoverDNS: () => Promise<void>
  commitHandoff: () => Promise<void>
  onCleanupError?: (error: unknown) => void
}): Promise<void> {
  let managedCoreStopped = false
  let detachedStartAttempted = false
  try {
    await dependencies.stopManagedCorePreservingDNS()
    managedCoreStopped = true
    detachedStartAttempted = true
    await dependencies.startDetachedCore()
    const outcome = await dependencies.reconcileDNS()
    if (outcome.kind === 'not-ready' || outcome.kind === 'stale') {
      throw new Error('DNS resolver did not become ready for detached core handoff')
    }
    await dependencies.commitHandoff()
  } catch (error) {
    if (managedCoreStopped) {
      if (detachedStartAttempted) {
        try {
          await dependencies.stopDetachedCorePreservingDNS()
        } catch (cleanupError) {
          dependencies.onCleanupError?.(cleanupError)
        }
      }
      try {
        await dependencies.recoverDNS()
      } catch (cleanupError) {
        dependencies.onCleanupError?.(cleanupError)
      }
    }
    throw error
  }
}

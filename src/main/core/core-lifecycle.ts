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
    ((ms) =>
      new Promise<void>((resolve) => {
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

export async function runDetachedCoreDNSHandoff<PreparedCore>(dependencies: {
  prepareDetachedCore: () => Promise<PreparedCore>
  requiresDNS?: (prepared: PreparedCore) => boolean
  prepareGuardian: () => Promise<void>
  stopManagedCorePreservingDNS: () => Promise<void>
  startDetachedCore: (prepared: PreparedCore) => Promise<void>
  reconcileDNS: () => Promise<DNSReconcileOutcome>
  registerGuardian: () => Promise<void>
  stopDetachedCorePreservingDNS: () => Promise<void>
  recoverDNS: () => Promise<void>
  revokeGuardian: () => Promise<void>
  rollbackManagedCore: () => Promise<void>
  clearHandoffArtifacts?: () => Promise<void>
  commitHandoff: () => Promise<void>
  onCleanupError?: (error: unknown) => void
}): Promise<void> {
  let managedCoreStopAttempted = false
  let detachedStartAttempted = false
  let guardianPreparationAttempted = false
  try {
    const prepared = await dependencies.prepareDetachedCore()
    guardianPreparationAttempted = true
    await dependencies.prepareGuardian()
    managedCoreStopAttempted = true
    await dependencies.stopManagedCorePreservingDNS()
    detachedStartAttempted = true
    await dependencies.startDetachedCore(prepared)
    const outcome = await dependencies.reconcileDNS()
    if (
      outcome.kind === 'not-ready' ||
      outcome.kind === 'stale' ||
      (dependencies.requiresDNS?.(prepared) && outcome.kind !== 'applied')
    ) {
      throw new Error('DNS resolver did not become ready for detached core handoff')
    }
    await dependencies.registerGuardian()
    await dependencies.commitHandoff()
  } catch (error) {
    if (!managedCoreStopAttempted) {
      if (guardianPreparationAttempted) {
        try {
          await dependencies.revokeGuardian()
        } catch (rollbackError) {
          dependencies.onCleanupError?.(rollbackError)
          throw new AggregateError(
            [error, rollbackError],
            'Detached DNS guardian preparation failed'
          )
        }
      }
      throw error
    }

    const rollbackErrors: unknown[] = []
    const attemptRollback = async (rollback: () => Promise<void>): Promise<void> => {
      try {
        await rollback()
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
        dependencies.onCleanupError?.(rollbackError)
      }
    }

    if (guardianPreparationAttempted) {
      await attemptRollback(dependencies.revokeGuardian)
    }
    if (detachedStartAttempted) {
      await attemptRollback(dependencies.stopDetachedCorePreservingDNS)
    }
    if (dependencies.clearHandoffArtifacts) {
      await attemptRollback(dependencies.clearHandoffArtifacts)
    }
    await attemptRollback(dependencies.recoverDNS)
    await attemptRollback(dependencies.rollbackManagedCore)

    if (rollbackErrors.length > 0) {
      try {
        await dependencies.recoverDNS()
      } catch (recoveryError) {
        rollbackErrors.push(recoveryError)
        dependencies.onCleanupError?.(recoveryError)
      }
      throw new AggregateError(
        [error, ...rollbackErrors],
        'Detached core handoff and rollback failed'
      )
    }
    throw error
  }
}

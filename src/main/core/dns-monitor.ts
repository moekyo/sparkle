export interface PowerResumeSource {
  on(event: 'resume', listener: () => void): unknown
}

export function registerDNSResumeReconciliation(
  powerMonitor: PowerResumeSource,
  isAllowed: () => boolean,
  schedule: () => void
): void {
  powerMonitor.on('resume', () => {
    if (isAllowed()) schedule()
  })
}

export function createDNSLifecycleMonitor(options: {
  reconcile: () => Promise<unknown>
  getPhysicalOwner: () => Promise<string | undefined>
  initialPhysicalOwner: string | undefined
  debounceMs?: number
  pollIntervalMs?: number
  reconcileIntervalMs?: number
  readinessRetryMs?: number
  onOwnerChange?: () => void
  onError?: (error: unknown) => void
}): {
  start: () => void
  schedule: () => void
  stop: () => void
} {
  let active = false
  let pollingOwner = false
  let physicalOwner = options.initialPhysicalOwner
  let ownerPollTimer: NodeJS.Timeout | undefined
  let reconcilePollTimer: NodeJS.Timeout | undefined
  let reconcileTimer: NodeJS.Timeout | undefined
  let readinessRetryTimer: NodeJS.Timeout | undefined
  const debounceMs = options.debounceMs ?? 300
  const pollIntervalMs = options.pollIntervalMs ?? 5000
  const readinessRetryMs = options.readinessRetryMs ?? 5000

  const retryWhenReady = (): void => {
    if (!active || readinessRetryMs <= 0 || readinessRetryTimer) return
    readinessRetryTimer = setTimeout(() => {
      readinessRetryTimer = undefined
      schedule()
    }, readinessRetryMs)
  }

  const schedule = (): void => {
    if (!active) return
    if (readinessRetryTimer) {
      clearTimeout(readinessRetryTimer)
      readinessRetryTimer = undefined
    }
    if (reconcileTimer) clearTimeout(reconcileTimer)
    reconcileTimer = setTimeout(() => {
      reconcileTimer = undefined
      if (!active) return
      options.reconcile().then(
        (outcome) => {
          if ((outcome as { kind?: string } | undefined)?.kind === 'not-ready') retryWhenReady()
        },
        (error) => {
          options.onError?.(error)
          retryWhenReady()
        }
      )
    }, debounceMs)
  }

  const pollPhysicalOwner = async (): Promise<void> => {
    if (!active || pollingOwner) return
    pollingOwner = true
    try {
      const nextOwner = await options.getPhysicalOwner()
      if (!active || nextOwner === physicalOwner) return
      physicalOwner = nextOwner
      options.onOwnerChange?.()
      schedule()
    } catch (error) {
      options.onError?.(error)
    } finally {
      pollingOwner = false
    }
  }

  const start = (): void => {
    if (active) return
    active = true
    ownerPollTimer = setInterval(() => {
      void pollPhysicalOwner()
    }, pollIntervalMs)
    reconcilePollTimer = setInterval(schedule, options.reconcileIntervalMs ?? 15000)
    schedule()
    void pollPhysicalOwner()
  }

  const stop = (): void => {
    active = false
    if (ownerPollTimer) {
      clearInterval(ownerPollTimer)
      ownerPollTimer = undefined
    }
    if (reconcilePollTimer) {
      clearInterval(reconcilePollTimer)
      reconcilePollTimer = undefined
    }
    if (reconcileTimer) {
      clearTimeout(reconcileTimer)
      reconcileTimer = undefined
    }
    if (readinessRetryTimer) {
      clearTimeout(readinessRetryTimer)
      readinessRetryTimer = undefined
    }
  }

  return { start, schedule, stop }
}

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDNSLifecycleMonitor, registerDNSResumeReconciliation } from './dns-monitor'

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms)
  })
}

test('power resume reconciles DNS even when network detection is disabled', async () => {
  const networkDetection = false
  let reconcilations = 0
  let resumeListener: (() => void) | undefined
  const monitor = createDNSLifecycleMonitor({
    reconcile: async () => {
      reconcilations++
    },
    getPhysicalOwner: async () => 'Wi-Fi',
    initialPhysicalOwner: 'Wi-Fi',
    debounceMs: 5,
    pollIntervalMs: 1000
  })
  registerDNSResumeReconciliation(
    {
      on: (_event, listener) => {
        resumeListener = listener
      }
    },
    () => !networkDetection,
    () => monitor.schedule()
  )

  monitor.start()
  resumeListener?.()
  await delay(20)
  monitor.stop()

  assert.equal(networkDetection, false)
  assert.equal(reconcilations, 1)
})

test('physical network owner changes schedule a debounced DNS reconciliation', async () => {
  let owner: string | undefined = 'Ethernet'
  let reconciliations = 0
  const monitor = createDNSLifecycleMonitor({
    reconcile: async () => {
      reconciliations++
    },
    getPhysicalOwner: async () => owner,
    initialPhysicalOwner: 'Ethernet',
    debounceMs: 5,
    pollIntervalMs: 5
  })

  monitor.start()
  owner = 'Wi-Fi'
  await delay(25)
  monitor.stop()

  assert.equal(reconciliations, 1)
})

test('periodically reconciles runtime DNS changes without network detection', async () => {
  let reconciliations = 0
  const monitor = createDNSLifecycleMonitor({
    reconcile: async () => {
      reconciliations++
    },
    getPhysicalOwner: async () => 'Wi-Fi',
    initialPhysicalOwner: 'Wi-Fi',
    debounceMs: 1,
    pollIntervalMs: 1000,
    reconcileIntervalMs: 8
  })

  monitor.start()
  await delay(25)
  monitor.stop()

  assert.ok(reconciliations >= 2)
})

test('owner changes invalidate in-flight decisions and not-ready reconciliation retries', async () => {
  let owner: string | undefined = 'Ethernet'
  let reconciliations = 0
  let invalidations = 0
  const monitor = createDNSLifecycleMonitor({
    reconcile: async () => {
      reconciliations++
      return reconciliations === 1 ? { kind: 'not-ready' } : { kind: 'applied' }
    },
    getPhysicalOwner: async () => owner,
    initialPhysicalOwner: 'Ethernet',
    debounceMs: 1,
    pollIntervalMs: 5,
    readinessRetryMs: 5,
    onOwnerChange: () => invalidations++
  })

  monitor.start()
  monitor.schedule()
  await delay(20)
  assert.equal(reconciliations, 2)
  owner = 'Wi-Fi'
  await delay(20)
  monitor.stop()

  assert.equal(invalidations, 1)
  assert.equal(reconciliations, 3)
})

test('transient DNS reconcile errors are retried after startup', async () => {
  let reconciliations = 0
  const monitor = createDNSLifecycleMonitor({
    reconcile: async () => {
      reconciliations++
      if (reconciliations === 1) throw new Error('controller request failed')
      return { kind: 'applied' }
    },
    getPhysicalOwner: async () => undefined,
    initialPhysicalOwner: undefined,
    debounceMs: 1,
    pollIntervalMs: 1000,
    readinessRetryMs: 5
  })

  monitor.start()
  await delay(20)
  monitor.stop()

  assert.equal(reconciliations, 2)
})

test('shutdown prevents queued resume reconciliation from starting', async () => {
  let allowed = true
  let reconciliations = 0
  let resumeListener: (() => void) | undefined
  const monitor = createDNSLifecycleMonitor({
    reconcile: async () => {
      reconciliations++
    },
    getPhysicalOwner: async () => undefined,
    initialPhysicalOwner: undefined,
    debounceMs: 10,
    pollIntervalMs: 1000
  })
  registerDNSResumeReconciliation(
    { on: (_event, listener) => (resumeListener = listener) },
    () => allowed,
    () => monitor.schedule()
  )

  monitor.start()
  resumeListener?.()
  allowed = false
  resumeListener?.()
  monitor.stop()
  await delay(20)

  assert.equal(reconciliations, 0)
})

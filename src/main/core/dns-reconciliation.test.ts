import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDNSLifecycle, type DNSLifecycleState, type DNSWriteMode } from './dns-lifecycle'
import { createDNSReconciler } from './dns-reconciliation'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createReconcileHarness() {
  let persistedState: DNSLifecycleState = {}
  let service = 'Wi-Fi'
  let target = '127.0.0.1'
  const dnsByService = new Map([
    ['Wi-Fi', '1.1.1.1 8.8.8.8'],
    ['Ethernet', '9.9.9.9']
  ])
  const writes: Array<{ service: string; dns: string; mode: DNSWriteMode }> = []
  const probes: Array<{ target: string; result: ReturnType<typeof deferred<boolean>> }> = []
  const probeListeners: Array<(probe: (typeof probes)[number]) => void> = []
  const lifecycle = createDNSLifecycle({
    readState: async () => ({ ...persistedState }),
    writeState: async (state) => {
      persistedState = { ...state }
    },
    getDefaultService: async () => service,
    readDNS: async (name) => dnsByService.get(name) || 'Empty',
    writeDNS: async (name, dns, mode) => {
      writes.push({ service: name, dns, mode })
      dnsByService.set(name, dns)
    }
  })
  const reconciler = createDNSReconciler({
    getMode: async () => 'exec',
    isOnline: () => true,
    getRuntimeConfig: async () => ({ dns: { enable: true }, tun: { enable: true } }),
    getControllerConfig: async () => ({ tun: { enable: true } }),
    resolveTarget: () => target,
    waitForResolver: (probeTarget) => {
      const probe = { target: probeTarget, result: deferred<boolean>() }
      probes.push(probe)
      for (const listener of probeListeners.splice(0)) listener(probe)
      return probe.result.promise
    },
    apply: (dns, mode) => lifecycle.apply(dns, mode),
    recover: (mode) => lifecycle.recover(mode)
  })

  return {
    reconciler,
    lifecycle,
    probes,
    writes,
    dnsByService,
    get state() {
      return persistedState
    },
    setTarget(value: string) {
      target = value
    },
    setService(value: string) {
      service = value
    },
    waitForProbe(probeTarget: string, occurrence = 0): Promise<(typeof probes)[number]> {
      const matching = probes.filter((probe) => probe.target === probeTarget)
      if (matching[occurrence]) return Promise.resolve(matching[occurrence])
      return new Promise((resolve) => {
        probeListeners.push((probe) => {
          if (probe.target !== probeTarget) return
          const current = probes.filter((item) => item.target === probeTarget)
          if (current[occurrence]) resolve(current[occurrence])
        })
      })
    }
  }
}

test('a resolver probe finishing after recovery cannot reapply DNS', async () => {
  const harness = createReconcileHarness()
  await harness.lifecycle.apply('127.0.0.9', 'exec')

  const oldReconcile = harness.reconciler.reconcile()
  const oldProbe = await harness.waitForProbe('127.0.0.1')
  await harness.reconciler.recover()
  oldProbe.result.resolve(true)
  await oldReconcile

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
  assert.deepEqual(harness.state, {})
  assert.deepEqual(
    harness.writes.map(({ dns }) => dns),
    ['127.0.0.9', '1.1.1.1 8.8.8.8']
  )
})

test('a failed TUN/controller readiness check never changes system DNS', async () => {
  const harness = createReconcileHarness()
  const unavailable = createDNSReconciler({
    getMode: async () => 'exec',
    isOnline: () => true,
    getRuntimeConfig: async () => ({ dns: { enable: true }, tun: { enable: false } }),
    getControllerConfig: async () => ({ tun: { enable: true } }),
    resolveTarget: () => '127.0.0.1',
    waitForResolver: async () => true,
    apply: (dns, mode) => harness.lifecycle.apply(dns, mode),
    recover: (mode) => harness.lifecycle.recover(mode)
  })

  assert.deepEqual(await unavailable.reconcile(), { kind: 'recovered' })
  assert.equal(harness.writes.length, 0)
  assert.deepEqual(harness.state, {})
})

test('a slower old resolver cannot overwrite a newer reconcile generation', async () => {
  const harness = createReconcileHarness()
  const oldReconcile = harness.reconciler.reconcile()
  const oldProbe = await harness.waitForProbe('127.0.0.1')

  harness.setTarget('127.0.0.2')
  const newReconcile = harness.reconciler.reconcile()
  const newProbe = await harness.waitForProbe('127.0.0.2')
  newProbe.result.resolve(true)
  await newReconcile
  oldProbe.result.resolve(true)
  await oldReconcile

  assert.equal(harness.dnsByService.get('Wi-Fi'), '127.0.0.2')
  assert.equal(harness.state.appliedDNS, '127.0.0.2')
  assert.deepEqual(
    harness.writes.map(({ dns }) => dns),
    ['127.0.0.2']
  )
})

test('a late old-service reconcile cannot undo a service-owner switch', async () => {
  const harness = createReconcileHarness()
  await harness.lifecycle.apply('127.0.0.1', 'exec')
  const oldReconcile = harness.reconciler.reconcile()
  const oldProbe = await harness.waitForProbe('127.0.0.1')

  harness.setService('Ethernet')
  harness.setTarget('127.0.0.2')
  const newReconcile = harness.reconciler.reconcile()
  const newProbe = await harness.waitForProbe('127.0.0.2')
  newProbe.result.resolve(true)
  await newReconcile
  oldProbe.result.resolve(true)
  await oldReconcile

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
  assert.equal(harness.dnsByService.get('Ethernet'), '127.0.0.2')
  assert.equal(harness.state.targetService, 'Ethernet')
  assert.deepEqual(
    harness.writes.map(({ service, dns }) => ({ service, dns })),
    [
      { service: 'Wi-Fi', dns: '127.0.0.1' },
      { service: 'Wi-Fi', dns: '1.1.1.1 8.8.8.8' },
      { service: 'Ethernet', dns: '127.0.0.2' }
    ]
  )
})

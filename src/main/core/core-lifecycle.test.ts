import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDNSLifecycle, type DNSLifecycleState, type DNSWriteMode } from './dns-lifecycle'
import {
  reconcileDNSWhenControllerReady,
  runDetachedCoreDNSHandoff,
  waitForControllerReady
} from './core-lifecycle'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function createOwnedDNS() {
  let state: DNSLifecycleState = {}
  const dnsByService = new Map([['Wi-Fi', '1.1.1.1 8.8.8.8']])
  const lifecycle = createDNSLifecycle({
    readState: async () => ({ ...state }),
    writeState: async (next) => {
      state = { ...next }
    },
    getDefaultService: async () => 'Wi-Fi',
    readDNS: async (service) => dnsByService.get(service) || 'Empty',
    writeDNS: async (service, dns, _mode: DNSWriteMode) => {
      dnsByService.set(service, dns)
    }
  })

  return {
    lifecycle,
    dnsByService,
    get state() {
      return state
    }
  }
}

test('keeps DNS ownership through detached readiness and hands it to the new resolver before commit', async () => {
  const ownedDNS = createOwnedDNS()
  await ownedDNS.lifecycle.apply('127.0.0.1', 'exec')
  const events: string[] = []
  const started = deferred<void>()
  const ready = deferred<void>()
  const handoff = runDetachedCoreDNSHandoff({
    stopManagedCorePreservingDNS: async () => {
      events.push('stop-managed-preserve')
    },
    startDetachedCore: async () => {
      events.push('start-detached')
      started.resolve()
      await ready.promise
      events.push('detached-ready')
    },
    reconcileDNS: async () => {
      events.push('reconcile-new-resolver')
      await ownedDNS.lifecycle.apply('127.0.0.2', 'exec')
      return { kind: 'applied' as const, target: '127.0.0.2' }
    },
    stopDetachedCorePreservingDNS: async () => {
      events.push('stop-detached')
    },
    recoverDNS: () => ownedDNS.lifecycle.recover(),
    commitHandoff: async () => {
      events.push('commit')
    }
  })

  await started.promise
  assert.equal(ownedDNS.dnsByService.get('Wi-Fi'), '127.0.0.1')
  assert.equal(ownedDNS.state.appliedDNS, '127.0.0.1')
  assert.equal(events.includes('commit'), false)

  ready.resolve()
  await handoff

  assert.equal(ownedDNS.dnsByService.get('Wi-Fi'), '127.0.0.2')
  assert.equal(ownedDNS.state.originDNS, '1.1.1.1 8.8.8.8')
  assert.equal(ownedDNS.state.appliedDNS, '127.0.0.2')
  assert.deepEqual(events, [
    'stop-managed-preserve',
    'start-detached',
    'detached-ready',
    'reconcile-new-resolver',
    'commit'
  ])
})

test('detached startup failure stops the replacement and restores the original DNS', async () => {
  const ownedDNS = createOwnedDNS()
  await ownedDNS.lifecycle.apply('127.0.0.1', 'exec')
  let stoppedReplacement = false

  await assert.rejects(
    runDetachedCoreDNSHandoff({
      stopManagedCorePreservingDNS: async () => {},
      startDetachedCore: async () => {
        throw new Error('controller failed to start')
      },
      reconcileDNS: async () => ({ kind: 'not-ready' as const }),
      stopDetachedCorePreservingDNS: async () => {
        stoppedReplacement = true
      },
      recoverDNS: () => ownedDNS.lifecycle.recover(),
      commitHandoff: async () => {}
    }),
    /controller failed to start/
  )

  assert.equal(stoppedReplacement, true)
  assert.equal(ownedDNS.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
  assert.deepEqual(ownedDNS.state, {})
})

test('controller readiness timeout is non-fatal and defers normal DNS reconciliation', async () => {
  const ready = await waitForControllerReady(
    async () => Promise.reject(new Error('controller not ready yet')),
    { maxRetries: 2, retryIntervalMs: 0, delay: async () => {} }
  )
  let appliedDNS = false
  let warnings = 0

  await reconcileDNSWhenControllerReady(
    async () => ready,
    async () => {
      appliedDNS = true
    },
    () => warnings++
  )

  assert.equal(ready, false)
  assert.equal(appliedDNS, false)
  assert.equal(warnings, 1)
})

test('controller readiness probe is bounded even when the request never settles', async () => {
  const ready = await waitForControllerReady(() => new Promise(() => {}), {
    timeoutMs: 5,
    maxRetries: 30,
    retryIntervalMs: 1
  })

  assert.equal(ready, false)
})

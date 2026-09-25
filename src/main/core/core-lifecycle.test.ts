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
    prepareDetachedCore: async () => {
      events.push('prepare-detached')
      return { prepared: true }
    },
    prepareGuardian: async () => {
      events.push('prepare-guardian')
    },
    stopManagedCorePreservingDNS: async () => {
      events.push('stop-managed-preserve')
    },
    startDetachedCore: async (prepared) => {
      assert.deepEqual(prepared, { prepared: true })
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
    registerGuardian: async () => {
      events.push('guardian-ready')
    },
    stopDetachedCorePreservingDNS: async () => {
      events.push('stop-detached')
    },
    recoverDNS: async () => {
      await ownedDNS.lifecycle.recover()
    },
    revokeGuardian: async () => {
      events.push('guardian-revoked')
    },
    rollbackManagedCore: async () => {
      events.push('rollback-managed')
    },
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
    'prepare-detached',
    'prepare-guardian',
    'stop-managed-preserve',
    'start-detached',
    'detached-ready',
    'reconcile-new-resolver',
    'guardian-ready',
    'commit'
  ])
})

test('detached startup failure stops replacement, restores DNS, and restarts managed core', async () => {
  const ownedDNS = createOwnedDNS()
  await ownedDNS.lifecycle.apply('127.0.0.1', 'exec')
  let stoppedReplacement = false
  const events: string[] = []

  await assert.rejects(
    runDetachedCoreDNSHandoff({
      prepareDetachedCore: async () => ({}),
      prepareGuardian: async () => {},
      stopManagedCorePreservingDNS: async () => {},
      startDetachedCore: async () => {
        throw new Error('controller failed to start')
      },
      reconcileDNS: async () => ({ kind: 'not-ready' as const }),
      registerGuardian: async () => {},
      stopDetachedCorePreservingDNS: async () => {
        stoppedReplacement = true
      },
      recoverDNS: async () => {
        await ownedDNS.lifecycle.recover()
      },
      revokeGuardian: async () => {},
      rollbackManagedCore: async () => {
        events.push('managed-restarted-and-reconciled')
      },
      commitHandoff: async () => {}
    }),
    /controller failed to start/
  )

  assert.equal(stoppedReplacement, true)
  assert.equal(ownedDNS.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
  assert.deepEqual(ownedDNS.state, {})
  assert.deepEqual(events, ['managed-restarted-and-reconciled'])
})

test('handoff prepares the replacement while the managed core is alive', async () => {
  let managedAlive = true
  const events: string[] = []

  await runDetachedCoreDNSHandoff({
    prepareDetachedCore: async () => {
      assert.equal(managedAlive, true)
      events.push('network-preflight')
      return 'prepared-profile'
    },
    prepareGuardian: async () => {
      events.push('prepare-guardian')
    },
    stopManagedCorePreservingDNS: async () => {
      managedAlive = false
      events.push('stop-managed')
    },
    startDetachedCore: async (prepared) => {
      assert.equal(prepared, 'prepared-profile')
      events.push('spawn-prepared')
    },
    reconcileDNS: async () => ({ kind: 'applied', target: '127.0.0.1' }),
    registerGuardian: async () => {
      events.push('guardian-ready')
    },
    stopDetachedCorePreservingDNS: async () => {},
    recoverDNS: async () => {},
    revokeGuardian: async () => {},
    rollbackManagedCore: async () => {},
    commitHandoff: async () => {
      events.push('commit')
    }
  })

  assert.deepEqual(events, [
    'network-preflight',
    'prepare-guardian',
    'stop-managed',
    'spawn-prepared',
    'guardian-ready',
    'commit'
  ])
})

test('handoff rolls back when required DNS ownership was not applied', async () => {
  const events: string[] = []

  await assert.rejects(
    runDetachedCoreDNSHandoff({
      prepareDetachedCore: async () => ({ requiresDNS: true }),
      requiresDNS: (prepared) => prepared.requiresDNS,
      prepareGuardian: async () => {},
      stopManagedCorePreservingDNS: async () => {},
      startDetachedCore: async () => {},
      reconcileDNS: async () => ({ kind: 'recovered' }),
      registerGuardian: async () => {},
      stopDetachedCorePreservingDNS: async () => {
        events.push('stop-replacement')
      },
      recoverDNS: async () => {
        events.push('recover-origin')
      },
      revokeGuardian: async () => {},
      rollbackManagedCore: async () => {
        events.push('restart-managed')
      },
      commitHandoff: async () => {
        events.push('commit')
      }
    }),
    /DNS resolver did not become ready/
  )

  assert.deepEqual(events, ['stop-replacement', 'recover-origin', 'restart-managed'])
})

test('failed replacement rolls back managed core and surfaces rollback errors', async () => {
  const original = new Error('detached startup failed')
  const rollback = new Error('managed restart failed')
  let replacementStopped = false
  let originRecovered = false

  await assert.rejects(
    runDetachedCoreDNSHandoff({
      prepareDetachedCore: async () => ({}),
      prepareGuardian: async () => {},
      stopManagedCorePreservingDNS: async () => {},
      startDetachedCore: async () => {
        throw original
      },
      reconcileDNS: async () => ({ kind: 'not-ready' }),
      registerGuardian: async () => {},
      stopDetachedCorePreservingDNS: async () => {
        replacementStopped = true
      },
      recoverDNS: async () => {
        originRecovered = true
      },
      revokeGuardian: async () => {},
      rollbackManagedCore: async () => {
        throw rollback
      },
      commitHandoff: async () => {}
    }),
    (error: unknown) => {
      assert.ok(error instanceof AggregateError)
      assert.deepEqual(error.errors, [original, rollback])
      return true
    }
  )

  assert.equal(replacementStopped, true)
  assert.equal(originRecovered, true)
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

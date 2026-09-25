import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDNSOwnerCoordinator } from './dns-owner-coordinator'
import { createDNSGuardian } from './dns-guardian'
import type { DNSOwnerRecord } from './dns-owner'

test('app relaunch requests guardian handback before claiming managed DNS ownership', async () => {
  const original: DNSOwnerRecord = {
    version: 1,
    owner: { kind: 'detached-guardian', generation: 'guardian-1', pid: 700 },
    detached: {
      generation: 'guardian-1',
      guardianPid: 700,
      status: 'active',
      ready: true,
      corePid: 900,
      coreStartedAt: 'started-900',
      targetService: 'Wi-Fi',
      originDNS: '1.1.1.1',
      appliedDNS: '127.0.0.1',
      appliedDNSMode: 'exec'
    }
  }
  let record: DNSOwnerRecord | undefined = structuredClone(original)
  let coreAlive = true
  const events: string[] = []
  const store = {
    read: async () => (record ? structuredClone(record) : undefined),
    write: async (next: DNSOwnerRecord) => {
      record = structuredClone(next)
    },
    clear: async (generation: string) => {
      if (record?.detached?.generation !== generation) return false
      record = undefined
      return true
    }
  }
  const guardian = createDNSGuardian({
    token: { kind: 'detached-guardian', generation: 'guardian-1' },
    readOwner: store.read,
    writeOwner: store.write,
    clearOwner: store.clear,
    isProcessAlive: async () => true,
    isCoreAlive: async () => coreAlive,
    isDNSApplied: async () => true,
    stopCore: async () => {
      coreAlive = false
      events.push('stop-core')
    },
    reconcileDNS: async () => {},
    recoverDNS: async () => {
      events.push('recover-dns')
    },
    startMonitor: () => {},
    stopMonitor: () => events.push('stop-monitor'),
    onExit: () => events.push('guardian-exit')
  })
  const coordinator = createDNSOwnerCoordinator({
    store,
    isProcessAlive: async () => false,
    isGuardianAlive: async () => true,
    requestGuardianRelease: async (current) => {
      record = {
        ...current,
        detached: {
          ...current.detached!,
          request: { type: 'relaunch', requestId: 'r1', requestedBy: 42 }
        }
      }
      await guardian.poll()
    },
    stopDetachedCore: async () => {
      events.push('fallback-stop-core')
    },
    recoverDNS: async () => {
      events.push('fallback-recover')
    }
  })

  const owner = await coordinator.acquireManagedOwner(42)

  assert.equal(owner.kind, 'managed-app')
  assert.equal(record?.owner.kind, 'managed-app')
  assert.deepEqual(events, ['stop-core', 'recover-dns', 'guardian-exit'])
  assert.equal(coreAlive, false)
})

test('managed startup cannot race an in-progress detached handoff', async () => {
  const store = {
    read: async () => ({
      version: 1 as const,
      owner: { kind: 'managed-app' as const, generation: 'managed-1', pid: 42 },
      detached: {
        generation: 'guardian-1',
        guardianPid: 700,
        status: 'preparing' as const,
        ready: false
      }
    }),
    write: async () => {},
    clear: async () => true
  }
  const coordinator = createDNSOwnerCoordinator({
    store,
    isProcessAlive: async () => true,
    isGuardianAlive: async () => true,
    requestGuardianRelease: async () => {},
    stopDetachedCore: async () => {},
    recoverDNS: async () => {}
  })

  await assert.rejects(coordinator.acquireManagedOwner(42), /handoff is already in progress/)
})

test('managed owner PID reuse is detected by process identity before ownership recovery', async () => {
  let record: DNSOwnerRecord | undefined = {
    version: 1,
    owner: {
      kind: 'managed-app',
      generation: 'stale-generation',
      pid: 42,
      startedAt: 'old-process'
    }
  }
  const recovered: string[] = []
  const store = {
    read: async () => record,
    write: async (next: DNSOwnerRecord) => {
      record = next
    },
    clear: async (generation: string) => {
      if (record?.owner.generation !== generation) return false
      record = undefined
      return true
    }
  }
  const coordinator = createDNSOwnerCoordinator({
    store,
    isProcessAlive: async () => true,
    isOwnerProcessAlive: async (owner) => owner.startedAt === 'current-process',
    getProcessIdentity: async () => 'current-process',
    isGuardianAlive: async () => false,
    requestGuardianRelease: async () => {},
    stopDetachedCore: async () => {},
    recoverDNS: async (owner) => {
      recovered.push(owner.generation)
    }
  })

  const owner = await coordinator.acquireManagedOwner(42)

  assert.notEqual(owner.generation, 'stale-generation')
  assert.deepEqual(recovered, ['stale-generation'])
  assert.equal(record?.owner.startedAt, 'current-process')
})

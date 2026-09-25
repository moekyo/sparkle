import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDNSGuardian } from './dns-guardian'
import type { DNSOwnerRecord, DNSOwnerToken } from './dns-owner'

const guardianToken: DNSOwnerToken = { kind: 'detached-guardian', generation: 'g-2' }
const managedToken: DNSOwnerToken = { kind: 'managed-app', generation: 'g-1' }

function activeRecord(): DNSOwnerRecord {
  return {
    version: 1,
    owner: { ...guardianToken, pid: 700 },
    detached: {
      generation: guardianToken.generation,
      guardianPid: 700,
      status: 'active',
      ready: true,
      corePid: 900,
      coreStartedAt: 'started-900',
      corePath: '/app/mihomo',
      targetService: 'Wi-Fi',
      originDNS: '1.1.1.1 8.8.8.8',
      appliedDNS: '127.0.0.1',
      appliedDNSMode: 'exec'
    }
  }
}

function createHarness(initial: DNSOwnerRecord) {
  let record: DNSOwnerRecord | undefined = initial
  let coreAlive = true
  let stopCoreFails = false
  let dnsApplied = true
  const events: string[] = []
  const guardian = createDNSGuardian({
    token: guardianToken,
    readOwner: async () => (record ? structuredClone(record) : undefined),
    writeOwner: async (next) => {
      record = structuredClone(next)
      events.push('write-owner')
    },
    clearOwner: async (generation) => {
      if (record?.detached?.generation !== generation) return false
      record = undefined
      events.push('clear-owner')
      return true
    },
    isProcessAlive: async () => true,
    isCoreAlive: async (pid, startedAt, corePath) =>
      pid === 900 &&
      coreAlive &&
      (startedAt === 'started-900' || (!startedAt && corePath === '/app/mihomo')),
    getProcessIdentity: (pid) => (pid === 900 ? 'started-900' : undefined),
    isDNSApplied: async () => dnsApplied,
    stopCore: async () => {
      events.push('stop-core')
      if (stopCoreFails) throw new Error('core did not stop')
      coreAlive = false
    },
    reconcileDNS: async () => events.push('reconcile'),
    recoverDNS: async () => {
      events.push('recover')
    },
    startMonitor: () => events.push('monitor-start'),
    stopMonitor: () => events.push('monitor-stop'),
    onExit: () => events.push('exit')
  })

  return {
    guardian,
    events,
    get record() {
      return record
    },
    setCoreAlive(value: boolean) {
      coreAlive = value
    },
    setDNSApplied(value: boolean) {
      dnsApplied = value
    },
    setStopCoreFails(value: boolean) {
      stopCoreFails = value
    },
    setRecord(value: DNSOwnerRecord | undefined) {
      record = value
    }
  }
}

test('persistent guardian restores DNS after Electron owner teardown and detached core death', async () => {
  const harness = createHarness(activeRecord())
  await harness.guardian.start()
  assert.ok(harness.events.includes('monitor-start'))

  // The Electron owner has exited. Only the independent guardian poll observes core death.
  harness.setCoreAlive(false)
  await harness.guardian.poll()

  assert.ok(harness.events.includes('recover'))
  assert.ok(harness.events.includes('clear-owner'))
  assert.ok(harness.events.includes('exit'))
  assert.equal(harness.record, undefined)
  harness.guardian.stop()
})

test('guardian preserves manually changed DNS and clears stale ownership after core death', async () => {
  const harness = createHarness(activeRecord())
  harness.setDNSApplied(false)
  await harness.guardian.start()

  assert.ok(harness.events.includes('recover'))
  assert.ok(harness.events.includes('clear-owner'))
  assert.equal(harness.events.includes('monitor-start'), false)
  harness.guardian.stop()
})

test('guardian restart resumes monitoring only for a live core with owned DNS', async () => {
  const live = createHarness(activeRecord())
  await live.guardian.start()
  assert.ok(live.events.includes('monitor-start'))
  assert.equal(live.events.includes('recover'), false)
  live.guardian.stop()

  const dead = createHarness(activeRecord())
  dead.setCoreAlive(false)
  await dead.guardian.start()
  assert.ok(dead.events.includes('recover'))
  assert.ok(dead.events.includes('clear-owner'))
  assert.equal(dead.events.includes('monitor-start'), false)
  dead.guardian.stop()
})

test('guardian adopts the core start identity persisted after an interrupted spawn handoff', async () => {
  const record = activeRecord()
  delete record.detached!.coreStartedAt
  const harness = createHarness(record)

  await harness.guardian.start()

  assert.equal(harness.record?.detached?.coreStartedAt, 'started-900')
  assert.ok(harness.events.includes('monitor-start'))
  harness.guardian.stop()
})

test('guardian refuses to exit when it cannot stop the core and keeps ownership active', async () => {
  const harness = createHarness(activeRecord())
  harness.setStopCoreFails(true)
  await harness.guardian.start()

  assert.equal(await harness.guardian.terminate(), false)
  assert.equal(harness.record?.owner.kind, 'detached-guardian')
  assert.equal(harness.events.includes('recover'), false)
  assert.equal(harness.events.includes('clear-owner'), false)
  assert.equal(harness.events.includes('exit'), false)

  await harness.guardian.poll()
  assert.ok(harness.events.includes('monitor-start'))
  harness.guardian.stop()
})

test('relaunch request stops the detached core before restoring and releasing guardian ownership', async () => {
  const record = activeRecord()
  record.detached!.request = { type: 'relaunch', requestId: 'request-1', requestedBy: 42 }
  const harness = createHarness(record)
  await harness.guardian.start()

  assert.deepEqual(
    harness.events.filter((event) =>
      ['stop-core', 'recover', 'clear-owner', 'exit'].includes(event)
    ),
    ['stop-core', 'recover', 'clear-owner', 'exit']
  )
  harness.guardian.stop()
})

test('late guardian work cannot write after ownership is transferred back to the app', async () => {
  const harness = createHarness(activeRecord())
  await harness.guardian.start()
  harness.setRecord({ version: 1, owner: { ...managedToken, pid: process.pid } })
  const previousEvents = [...harness.events]
  await harness.guardian.poll()

  assert.deepEqual(harness.events, [...previousEvents, 'monitor-stop', 'exit'])
  assert.equal(harness.events.includes('recover'), false)
  harness.guardian.stop()
})

test('guardian takes over a pending handoff if its Electron owner disappears', async () => {
  const record = activeRecord()
  record.owner = { ...managedToken, pid: 99 }
  record.owner.startedAt = 'parent-process'
  record.detached!.status = 'preparing'
  record.detached!.ready = false
  const harness = createHarness(record)
  // Simulate the parent process disappearing between detached spawn and ownership commit.
  const dependencies = {
    token: guardianToken,
    readOwner: async () => harness.record && structuredClone(harness.record),
    writeOwner: async (next: DNSOwnerRecord) => harness.setRecord(structuredClone(next)),
    clearOwner: async (generation: string) => {
      if (harness.record?.detached?.generation !== generation) return false
      harness.setRecord(undefined)
      return true
    },
    isProcessAlive: async () => true,
    isOwnerProcessAlive: async () => false,
    isCoreAlive: async (pid: number) => pid === 900,
    isDNSApplied: async () => true,
    stopCore: async () => {},
    reconcileDNS: async () => {},
    recoverDNS: async () => {},
    startMonitor: () => {},
    stopMonitor: () => {}
  }
  const guardian = createDNSGuardian(dependencies)
  await guardian.start()

  assert.equal(harness.record?.owner.kind, 'detached-guardian')
  assert.equal(harness.record?.detached?.status, 'active')
  guardian.stop()
})

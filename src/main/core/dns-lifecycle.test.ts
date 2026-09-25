import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDNSLifecycle,
  resolveSystemDnsTarget,
  runAfterCoreReady,
  type DNSLifecycleState,
  type DNSWriteMode
} from './dns-lifecycle'

function createDNSHarness(initialDNS: Record<string, string>, initialService = 'Wi-Fi') {
  let state: DNSLifecycleState = {}
  let defaultService = initialService
  const dnsByService = new Map(Object.entries(initialDNS))
  const writes: Array<{ service: string; dns: string; mode: DNSWriteMode }> = []
  const unavailableModes = new Set<DNSWriteMode>()
  const lifecycle = createDNSLifecycle({
    readState: async () => ({ ...state }),
    writeState: async (next) => {
      state = { ...next }
    },
    getDefaultService: async () => defaultService,
    readDNS: async (service) => dnsByService.get(service) || 'Empty',
    writeDNS: async (service, dns, mode) => {
      writes.push({ service, dns, mode })
      if (unavailableModes.has(mode)) throw new Error(`${mode} DNS writer unavailable`)
      dnsByService.set(service, dns)
    }
  })

  return {
    lifecycle,
    writes,
    dnsByService,
    get state() {
      return state
    },
    setDefaultService(service: string) {
      defaultService = service
    },
    setWriteModeUnavailable(mode: DNSWriteMode, unavailable: boolean) {
      if (unavailable) unavailableModes.add(mode)
      else unavailableModes.delete(mode)
    }
  }
}

test('restores an originally empty DNS service', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': 'Empty' })

  await harness.lifecycle.apply('127.0.0.1', 'exec')
  assert.equal(harness.state.originDNS, 'Empty')
  assert.equal(harness.state.appliedDNS, '127.0.0.1')
  assert.equal(harness.state.targetService, 'Wi-Fi')
  assert.equal(harness.dnsByService.get('Wi-Fi'), '127.0.0.1')

  await harness.lifecycle.recover()
  assert.equal(harness.dnsByService.get('Wi-Fi'), 'Empty')
  assert.equal(harness.state.originDNS, undefined)
  assert.equal(harness.state.appliedDNS, undefined)
})

test('restores all original DNS servers in order', async () => {
  const origin = '1.1.1.1 8.8.8.8'
  const harness = createDNSHarness({ 'Wi-Fi': origin })

  await harness.lifecycle.apply('127.0.0.1', 'service')
  await harness.lifecycle.recover()

  assert.equal(harness.dnsByService.get('Wi-Fi'), origin)
  assert.deepEqual(
    harness.writes.map(({ dns, mode }) => ({ dns, mode })),
    [
      { dns: '127.0.0.1', mode: 'service' },
      { dns: origin, mode: 'service' }
    ]
  )
})

test('uses the method that actually applied DNS when the selected mode changes', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })

  await harness.lifecycle.apply('127.0.0.1', 'exec')
  await harness.lifecycle.apply('127.0.0.1', 'service')
  assert.equal(harness.state.appliedDNSMode, 'exec')
  await harness.lifecycle.recover()

  assert.equal(harness.state.appliedDNSMode, undefined)
  assert.deepEqual(
    harness.writes.map(({ dns, mode }) => ({ dns, mode })),
    [
      { dns: '127.0.0.1', mode: 'exec' },
      { dns: '1.1.1.1', mode: 'exec' }
    ]
  )
})

test('falls back to exec mode if service mode can no longer restore DNS', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })

  await harness.lifecycle.apply('127.0.0.1', 'service')
  harness.setWriteModeUnavailable('service', true)
  await harness.lifecycle.recover()

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1')
  assert.equal(harness.writes.at(-1)?.mode, 'exec')
})

test('does not apply DNS when Mihomo readiness fails', async () => {
  let dnsWrites = 0

  await assert.rejects(
    runAfterCoreReady(
      async () => {
        throw new Error('Mihomo startup failed')
      },
      async () => {
        dnsWrites++
      }
    ),
    /Mihomo startup failed/
  )

  assert.equal(dnsWrites, 0)
})

test('resolves custom listener addresses independently of fake-IP ranges', () => {
  const tunStatus = { enable: true, 'inet4-address': ['198.51.100.7/30'] }
  const runtimeConfig = {
    dns: { enable: true, listen: '0.0.0.0:53' },
    tun: { enable: true, 'dns-hijack': ['any:53'] }
  }

  assert.equal(resolveSystemDnsTarget(runtimeConfig, tunStatus), '127.0.0.1')
  assert.equal(
    resolveSystemDnsTarget(
      { ...runtimeConfig, dns: { enable: true, listen: '192.0.2.53:53' } },
      tunStatus
    ),
    '192.0.2.53'
  )
  assert.equal(
    resolveSystemDnsTarget(
      { ...runtimeConfig, dns: { enable: true, listen: '127.0.0.2:53' } },
      tunStatus
    ),
    '127.0.0.2'
  )
})

test('reapplies DNS when the runtime resolver address changes', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1 8.8.8.8' })

  await harness.lifecycle.apply('127.0.0.1', 'exec')
  await harness.lifecycle.apply('127.0.0.2', 'exec')

  assert.equal(harness.dnsByService.get('Wi-Fi'), '127.0.0.2')
  assert.equal(harness.state.originDNS, '1.1.1.1 8.8.8.8')
  assert.equal(harness.state.appliedDNS, '127.0.0.2')
  assert.equal(harness.writes.length, 2)

  await harness.lifecycle.recover()
  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
})

test('uses the live TUN address when DNS hijack covers port 53', () => {
  const target = resolveSystemDnsTarget(
    {
      dns: { enable: true, listen: '127.0.0.1:5353' },
      tun: { enable: true, 'dns-hijack': ['any:53'] }
    },
    { enable: true, 'inet4-address': ['198.51.100.9/30'] }
  )

  assert.equal(target, '198.51.100.9')
})

test('restores the previous service and tracks the new service after a network change', async () => {
  const harness = createDNSHarness({
    'Wi-Fi': '1.1.1.1 8.8.8.8',
    Ethernet: '9.9.9.9'
  })

  await harness.lifecycle.apply('127.0.0.1', 'exec')
  harness.setDefaultService('Ethernet')
  await harness.lifecycle.apply('127.0.0.2', 'exec')

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
  assert.equal(harness.dnsByService.get('Ethernet'), '127.0.0.2')
  assert.equal(harness.state.targetService, 'Ethernet')
  assert.equal(harness.state.originDNS, '9.9.9.9')

  await harness.lifecycle.recover()
  assert.equal(harness.dnsByService.get('Ethernet'), '9.9.9.9')
})

test('preserves a manual DNS change when recovering', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })

  await harness.lifecycle.apply('127.0.0.1', 'exec')
  harness.dnsByService.set('Wi-Fi', '9.9.9.9')
  await harness.lifecycle.recover()

  assert.equal(harness.dnsByService.get('Wi-Fi'), '9.9.9.9')
  assert.equal(harness.writes.length, 1)
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  createDNSLifecycle,
  resolveSystemDnsTarget,
  type DNSLifecycleState,
  type DNSWriteMode
} from './dns-lifecycle'

function createDNSHarness(initialDNS: Record<string, string>, initialService = 'Wi-Fi') {
  let state: DNSLifecycleState = {}
  let defaultService = initialService
  let writeBehavior:
    | ((service: string, dns: string, mode: DNSWriteMode) => Promise<void>)
    | undefined
  const dnsByService = new Map(Object.entries(initialDNS))
  const writes: Array<{ service: string; dns: string; mode: DNSWriteMode }> = []
  const stateWrites: DNSLifecycleState[] = []
  const unavailableModes = new Set<DNSWriteMode>()
  const lifecycle = createDNSLifecycle({
    readState: async () => ({ ...state }),
    writeState: async (next) => {
      state = { ...next }
      stateWrites.push({ ...next })
    },
    getDefaultService: async () => defaultService,
    readDNS: async (service) => dnsByService.get(service) || 'Empty',
    writeDNS: async (service, dns, mode) => {
      writes.push({ service, dns, mode })
      if (unavailableModes.has(mode)) throw new Error(`${mode} DNS writer unavailable`)
      if (writeBehavior) {
        await writeBehavior(service, dns, mode)
        return
      }
      dnsByService.set(service, dns)
    }
  })

  return {
    lifecycle,
    writes,
    stateWrites,
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
    },
    setWriteBehavior(
      behavior: ((service: string, dns: string, mode: DNSWriteMode) => Promise<void>) | undefined
    ) {
      writeBehavior = behavior
    },
    setState(next: DNSLifecycleState) {
      state = { ...next }
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

test('recovers an interrupted apply when the target DNS was written before the crash', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '127.0.0.1' })
  harness.setState({
    phase: 'applying',
    originDNS: '1.1.1.1 8.8.8.8',
    appliedDNS: '127.0.0.1',
    targetService: 'Wi-Fi',
    appliedDNSMode: 'exec'
  })

  await harness.lifecycle.recover()

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1 8.8.8.8')
  assert.deepEqual(harness.state, {})
  assert.ok(harness.stateWrites.some((state) => state.phase === 'applied'))
  assert.ok(harness.stateWrites.some((state) => state.phase === 'restoring'))
})

test('clears an interrupted apply when origin DNS is still active', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })
  harness.setState({
    phase: 'applying',
    originDNS: '1.1.1.1',
    appliedDNS: '127.0.0.1',
    targetService: 'Wi-Fi',
    appliedDNSMode: 'exec'
  })

  await harness.lifecycle.recover()

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1')
  assert.deepEqual(harness.state, {})
  assert.equal(harness.writes.length, 0)
})

test('preserves third-party DNS found while recovering an interrupted apply', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '9.9.9.9' })
  harness.setState({
    phase: 'applying',
    originDNS: '1.1.1.1',
    appliedDNS: '127.0.0.1',
    targetService: 'Wi-Fi',
    appliedDNSMode: 'exec'
  })

  await harness.lifecycle.recover()

  assert.equal(harness.dnsByService.get('Wi-Fi'), '9.9.9.9')
  assert.deepEqual(harness.state, {})
  assert.equal(harness.writes.length, 0)
})

test('does not overwrite third-party DNS when reconciling an interrupted apply', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '9.9.9.9' })
  harness.setState({
    phase: 'applying',
    originDNS: '1.1.1.1',
    appliedDNS: '127.0.0.1',
    targetService: 'Wi-Fi',
    appliedDNSMode: 'exec'
  })

  await harness.lifecycle.apply('127.0.0.2', 'exec')

  assert.equal(harness.dnsByService.get('Wi-Fi'), '9.9.9.9')
  assert.deepEqual(harness.state, {})
  assert.equal(harness.writes.length, 0)
})

test('uses exec fallback when service DNS writer is unavailable during apply', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })
  harness.setWriteModeUnavailable('service', true)

  await harness.lifecycle.apply('127.0.0.1', 'service')

  assert.equal(harness.dnsByService.get('Wi-Fi'), '127.0.0.1')
  assert.equal(harness.state.appliedDNSMode, 'exec')
  assert.equal(harness.state.phase, 'applied')
  assert.deepEqual(
    harness.writes.map(({ mode }) => mode),
    ['service', 'exec']
  )
})

test('clears pending ownership if all DNS writers fail before changing DNS', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })
  harness.setWriteModeUnavailable('exec', true)
  harness.setWriteModeUnavailable('service', true)

  await assert.rejects(harness.lifecycle.apply('127.0.0.1', 'service'), /writer unavailable/)

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1')
  assert.deepEqual(harness.state, {})
})

test('does not commit ownership when DNS write read-back does not match target', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })
  harness.setWriteBehavior(async () => {})

  await assert.rejects(harness.lifecycle.apply('127.0.0.1', 'exec'), /verification/)

  assert.equal(harness.dnsByService.get('Wi-Fi'), '1.1.1.1')
  assert.deepEqual(harness.state, {})
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

test('resolves supported DNS listener host and transport forms', () => {
  const listenerTargets = [
    [':53', '127.0.0.1'],
    ['0.0.0.0:53', '127.0.0.1'],
    ['[::]:53', '::1'],
    ['127.0.0.1:53', '127.0.0.1'],
    ['localhost:53', '127.0.0.1'],
    ['192.0.2.53:53', '192.0.2.53'],
    ['[2001:db8::53]:53', '2001:db8::53'],
    ['udp://127.0.0.2:53', '127.0.0.2'],
    ['tcp://[2001:db8::54]:53', '2001:db8::54']
  ]
  const tunStatus = { enable: true, 'inet4-address': ['198.51.100.7/30'] }

  for (const [listen, expected] of listenerTargets) {
    assert.equal(
      resolveSystemDnsTarget(
        { dns: { enable: true, listen }, tun: { enable: true, 'dns-hijack': ['any:53'] } },
        tunStatus
      ),
      expected,
      `listen ${listen}`
    )
  }
})

test('resolves DNS hijack transport and TUN IPv4/IPv6 status without fake-IP defaults', () => {
  const noDirect53Listener = { dns: { enable: true, listen: '127.0.0.1:5353' } }
  const ipv4And6 = {
    enable: true,
    'inet4-address': ['198.51.100.8/30'],
    'inet6-address': ['2001:db8:1::8/126']
  }
  const ipv6Only = { enable: true, 'inet6-address': ['2001:db8:1::8/126'] }

  assert.equal(
    resolveSystemDnsTarget(
      { ...noDirect53Listener, tun: { enable: true, 'dns-hijack': ['any:53'] } },
      ipv4And6
    ),
    '198.51.100.8'
  )
  for (const hijack of ['0.0.0.0:53', 'tcp://any:53', 'udp://any:53']) {
    assert.equal(
      resolveSystemDnsTarget(
        { ...noDirect53Listener, tun: { enable: true, 'dns-hijack': [hijack] } },
        ipv6Only
      ),
      '2001:db8:1::8',
      `hijack ${hijack}`
    )
  }
  assert.equal(
    resolveSystemDnsTarget(
      { ...noDirect53Listener, tun: { enable: true, 'dns-hijack': ['192.0.2.54:53'] } },
      ipv4And6
    ),
    '192.0.2.54'
  )
})

test('does not select a listener or TUN address when no port-53 resolver is reachable', () => {
  const runtime = {
    dns: { enable: true, listen: '127.0.0.1:5353' },
    tun: { enable: true, 'dns-hijack': ['any:5353'] }
  }

  assert.equal(resolveSystemDnsTarget(runtime, { enable: true }), undefined)
  assert.equal(
    resolveSystemDnsTarget(
      { ...runtime, tun: { enable: true, 'dns-hijack': ['any:53'] } },
      { enable: true }
    ),
    undefined
  )
  assert.equal(
    resolveSystemDnsTarget(
      { ...runtime, dns: { enable: false, listen: '127.0.0.1:53' } },
      { enable: true, 'inet4-address': ['198.51.100.9/30'] }
    ),
    undefined
  )
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

test('preserves a manual DNS change during a later reconcile apply', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '1.1.1.1' })

  await harness.lifecycle.apply('127.0.0.1', 'exec')
  harness.dnsByService.set('Wi-Fi', '9.9.9.9')
  await harness.lifecycle.apply('127.0.0.2', 'exec')

  assert.equal(harness.dnsByService.get('Wi-Fi'), '9.9.9.9')
  assert.deepEqual(harness.state, {})
  assert.equal(harness.writes.length, 1)
})

test('preserves manual DNS when recovering legacy ownership without a committed phase', async () => {
  const harness = createDNSHarness({ 'Wi-Fi': '9.9.9.9' })
  harness.setState({
    originDNS: '1.1.1.1',
    appliedDNS: '127.0.0.1',
    targetService: 'Wi-Fi',
    appliedDNSMode: 'exec'
  })

  await harness.lifecycle.apply('127.0.0.2', 'exec')

  assert.equal(harness.dnsByService.get('Wi-Fi'), '9.9.9.9')
  assert.deepEqual(harness.state, {})
  assert.equal(harness.writes.length, 0)
})

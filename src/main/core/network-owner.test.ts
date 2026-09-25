import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseNetworkServiceOrder, resolvePhysicalNetworkOwner } from './network-owner'

const services = [
  { name: 'Wi-Fi', device: 'en0', disabled: false },
  { name: 'Ethernet', device: 'en3', disabled: false },
  { name: 'Thunderbolt Bridge', device: 'bridge0', disabled: false }
]

test('uses the observed default egress device when Wi-Fi and Ethernet are both active', () => {
  assert.deepEqual(
    resolvePhysicalNetworkOwner(
      { defaultDevice: 'en3', activeDevices: ['en0', 'en3'], services },
      { device: 'en0', service: 'Wi-Fi' }
    ),
    { device: 'en3', service: 'Ethernet' }
  )
})

test('migrates from an inactive Ethernet owner to the unique active Wi-Fi service', () => {
  assert.deepEqual(
    resolvePhysicalNetworkOwner(
      { defaultDevice: 'utun8', activeDevices: ['en0', 'utun8'], services },
      { device: 'en3', service: 'Ethernet' }
    ),
    { device: 'en0', service: 'Wi-Fi' }
  )
})

test('retains an active captured owner but does not guess when ownership is ambiguous', () => {
  assert.deepEqual(
    resolvePhysicalNetworkOwner(
      { defaultDevice: 'utun8', activeDevices: ['en0', 'en3', 'utun8'], services },
      { device: 'en3', service: 'Ethernet' }
    ),
    { device: 'en3', service: 'Ethernet' }
  )
  assert.equal(
    resolvePhysicalNetworkOwner(
      { defaultDevice: 'utun8', activeDevices: ['en0', 'en3', 'utun8'], services }
    ),
    undefined
  )
})

test('maps route device to service and excludes disabled/virtual services', () => {
  const parsed = parseNetworkServiceOrder(
    [
      '(1) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)',
      '(*) Disabled Ethernet\n(Hardware Port: Ethernet, Device: en3)',
      '(3) Tunnel\n(Hardware Port: VPN, Device: utun8)'
    ].join('\n\n')
  )
  assert.deepEqual(parsed, [
    { name: 'Wi-Fi', device: 'en0', disabled: false },
    { name: 'Disabled Ethernet', device: 'en3', disabled: true },
    { name: 'Tunnel', device: 'utun8', disabled: false }
  ])
  assert.deepEqual(
    resolvePhysicalNetworkOwner({
      defaultDevice: 'en3',
      activeDevices: ['en0', 'en3'],
      services: parsed
    }),
    undefined
  )
})

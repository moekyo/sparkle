import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  parseNetworkServiceOrder,
  parsePrimaryPhysicalService,
  resolvePhysicalNetworkOwner
} from './network-owner'

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

test('does not treat an active captured owner as authority when ownership is ambiguous', () => {
  assert.equal(
    resolvePhysicalNetworkOwner(
      { defaultDevice: 'utun8', activeDevices: ['en0', 'en3', 'utun8'], services },
      { device: 'en3', service: 'Ethernet' }
    ),
    undefined
  )
  assert.equal(
    resolvePhysicalNetworkOwner({
      defaultDevice: 'utun8',
      activeDevices: ['en0', 'en3', 'utun8'],
      services
    }),
    undefined
  )
})

test('moves an active captured owner when SystemConfiguration reports a new physical egress', () => {
  assert.deepEqual(
    resolvePhysicalNetworkOwner(
      {
        defaultDevice: 'utun8',
        primaryDevice: 'en0',
        primaryService: 'Wi-Fi',
        activeDevices: ['en0', 'en3', 'utun8'],
        services
      },
      { device: 'en3', service: 'Ethernet' }
    ),
    { device: 'en0', service: 'Wi-Fi' }
  )
})

test('fails closed when TUN is default and two physical interfaces are active without authority', () => {
  assert.equal(
    resolvePhysicalNetworkOwner(
      { defaultDevice: 'utun8', activeDevices: ['en0', 'en3', 'utun8'], services },
      { device: 'en3', service: 'Ethernet' }
    ),
    undefined
  )
})

test('uses the primary service UUID mapping and rejects virtual primary interfaces', () => {
  assert.deepEqual(
    parsePrimaryPhysicalService(
      `
    <dictionary> {
      PrimaryInterface : en3
      PrimaryService : 3C8D3E56-7
    }
  `,
      `
    <dictionary> {
      DeviceName : en3
      UserDefinedName : Ethernet
    }
  `
    ),
    { device: 'en3', service: 'Ethernet' }
  )

  assert.equal(
    parsePrimaryPhysicalService(
      `
    <dictionary> {
      PrimaryInterface : utun8
      PrimaryService : 3C8D3E56-7
    }
  `,
      `
    <dictionary> {
      DeviceName : utun8
      UserDefinedName : VPN
    }
  `
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

import { execFile } from 'child_process'
import { net } from 'electron'
import { Resolver } from 'node:dns/promises'
import os from 'os'
import { promisify } from 'util'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { setSysDns } from '../service/api'
import { triggerSysProxy } from '../sys/sysproxy'
import { appendAppLog } from '../utils/log'
import { getRuntimeConfig } from './factory'
import { mihomoConfig } from './mihomoApi'
import {
  createDNSLifecycle,
  normalizeDNS,
  resolveSystemDnsTarget,
  type DNSLifecycleState,
  type DNSWriteMode
} from './dns-lifecycle'

export interface NetworkCoreController {
  shouldStartCore: (networkDownHandled: boolean) => boolean
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
  reconcileDNS?: () => Promise<void>
}

let networkDetectionTimer: NodeJS.Timeout | null = null
let networkDetectionGeneration = 0
let networkDownHandled = false

let lastDNSStatus = ''
let networkDeviceHint: string | undefined

const dnsLifecycle = createDNSLifecycle({
  readState: async (): Promise<DNSLifecycleState> => {
    const { originDNS, appliedDNS, targetService, appliedDNSMode } = await getAppConfig()
    return { originDNS, appliedDNS, targetService, appliedDNSMode }
  },
  writeState: async (state) => {
    await patchAppConfig({
      originDNS: state.originDNS,
      appliedDNS: state.appliedDNS,
      targetService: state.targetService,
      appliedDNSMode: state.appliedDNSMode
    })
  },
  getDefaultService: () => getDefaultService(networkDeviceHint),
  readDNS: getServiceDNS,
  writeDNS: setDNS
})

export async function getDefaultDevice(): Promise<string> {
  const execFilePromise = promisify(execFile)
  const { stdout: deviceOut } = await execFilePromise('route', ['-n', 'get', 'default'])
  let device = deviceOut.split('\n').find((s) => s.includes('interface:'))
  device = device?.trim().split(' ').slice(1).join(' ')
  if (!device) throw new Error('Get device failed')
  return device
}

async function getDefaultService(deviceHint?: string): Promise<string> {
  const execFilePromise = promisify(execFile)
  const { stdout: order } = await execFilePromise('networksetup', ['-listnetworkserviceorder'])

  const blocks = order.split(/\n\s*\n/)
  if (deviceHint) {
    const hintedBlock = blocks.find((item) => item.includes(`Device: ${deviceHint}`))
    const hintedService = hintedBlock ? parseNetworkService(hintedBlock) : undefined
    if (hintedService && !hintedService.disabled) return hintedService.name
  }

  try {
    const device = await getDefaultDevice()
    const block = blocks.find((item) => item.includes(`Device: ${device}`))
    const service = block ? parseNetworkService(block) : undefined
    if (service && !service.disabled) return service.name
  } catch {
    // A running TUN can become the default route and hide the physical service.
  }

  const interfaces = os.networkInterfaces()
  for (const block of blocks) {
    const service = parseNetworkService(block)
    const device = service?.device.toLowerCase() || ''
    const virtualDevice = ['utun', 'bridge', 'awdl', 'llw', 'anpi', 'gif', 'stf', 'lo', 'ap'].some(
      (prefix) => device.startsWith(prefix)
    )
    if (
      !service ||
      service.disabled ||
      virtualDevice ||
      !interfaces[service.device]?.some(
        (iface) => !iface.internal && (iface.family === 'IPv4' || iface.family === 'IPv6')
      )
    ) {
      continue
    }
    return service.name
  }

  throw new Error('Get service failed')
}

function parseNetworkService(
  block: string
): { name: string; device: string; disabled: boolean } | undefined {
  const serviceMatch = block.match(/^\((\*|\d+)\)\s+(.+)$/m)
  const deviceMatch = block.match(/Device:\s*([^,)]+)/)
  if (!serviceMatch || !deviceMatch) return undefined
  return {
    name: serviceMatch[2].trim(),
    device: deviceMatch[1].trim(),
    disabled: serviceMatch[1] === '*'
  }
}

async function getServiceDNS(service: string): Promise<string> {
  const execFilePromise = promisify(execFile)
  const { stdout: dns } = await execFilePromise('networksetup', ['-getdnsservers', service])
  return normalizeDNS(dns)
}

async function setDNS(service: string, dns: string, mode: DNSWriteMode): Promise<void> {
  const normalizedDNS = normalizeDNS(dns)
  const dnsServers = normalizedDNS === 'Empty' ? ['Empty'] : normalizedDNS.split(' ')
  if (mode === 'exec') {
    const execFilePromise = promisify(execFile)
    await execFilePromise('networksetup', ['-setdnsservers', service, ...dnsServers])
    return
  }
  if (mode === 'service') {
    await setSysDns(service, dnsServers)
    return
  }
}

async function isDNSResolverAvailable(address: string): Promise<boolean> {
  const resolver = new Resolver()
  try {
    resolver.setServers([address])
  } catch {
    return false
  }

  return new Promise((resolve) => {
    let settled = false
    const finish = (available: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(available)
    }
    const timer = setTimeout(() => {
      resolver.cancel()
      finish(false)
    }, 1200)

    resolver.resolve4('sparkle-dns-probe.invalid').then(
      () => finish(true),
      (error: NodeJS.ErrnoException) =>
        finish(error.code === 'ENOTFOUND' || error.code === 'ENODATA')
    )
  })
}

async function waitForDNSResolver(address: string): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (await isDNSResolverAvailable(address)) return true
    if (attempt < 3) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 250)
      })
    }
  }
  return false
}

function reportDNSStatus(status: string): void {
  if (lastDNSStatus === status) return
  lastDNSStatus = status
  appendAppLog(`[Network]: ${status}\n`).catch(() => {})
}

export async function reconcileSystemDNS(): Promise<void> {
  if (process.platform !== 'darwin') return

  const { autoSetDNSMode = 'none' } = await getAppConfig()
  if (autoSetDNSMode === 'none') {
    await dnsLifecycle.recover(autoSetDNSMode)
    return
  }
  if (!net.isOnline()) {
    await dnsLifecycle.recover(autoSetDNSMode)
    return
  }

  const runtimeConfig = await getRuntimeConfig()
  if (!runtimeConfig?.tun?.enable || runtimeConfig.dns?.enable === false) {
    await dnsLifecycle.recover(autoSetDNSMode)
    return
  }

  let liveConfig: ControllerConfigs
  try {
    liveConfig = await mihomoConfig()
  } catch {
    await dnsLifecycle.recover(autoSetDNSMode)
    reportDNSStatus('Mihomo controller is unavailable; restored managed DNS if needed')
    return
  }

  if (!liveConfig?.tun?.enable) {
    await dnsLifecycle.recover(autoSetDNSMode)
    return
  }
  networkDeviceHint = liveConfig['interface-name'] || undefined

  const target = resolveSystemDnsTarget(runtimeConfig, liveConfig.tun)
  if (!target) {
    await dnsLifecycle.recover(autoSetDNSMode)
    reportDNSStatus('no reachable Mihomo DNS resolver is configured; system DNS was left unchanged')
    return
  }

  if (!(await waitForDNSResolver(target))) {
    await dnsLifecycle.recover(autoSetDNSMode)
    reportDNSStatus(`Mihomo DNS resolver ${target} did not answer; system DNS was left unchanged`)
    return
  }

  lastDNSStatus = ''
  await dnsLifecycle.apply(target, autoSetDNSMode)
}

export async function recoverDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  const { autoSetDNSMode = 'none' } = await getAppConfig()
  await dnsLifecycle.recover(autoSetDNSMode)
}

export async function startNetworkDetectionController(
  controller: NetworkCoreController
): Promise<void> {
  const generation = ++networkDetectionGeneration
  let detecting = false
  const { networkDetectionBypass = [], networkDetectionInterval = 10 } = await getAppConfig()
  const { tun: { device = process.platform === 'darwin' ? undefined : 'mihomo' } = {} } =
    await getControledMihomoConfig()
  if (generation !== networkDetectionGeneration) return
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
  }
  const extendedBypass = networkDetectionBypass.concat(
    [device, 'lo', 'docker0', 'utun'].filter((item): item is string => item !== undefined)
  )

  networkDetectionTimer = setInterval(async () => {
    if (detecting || generation !== networkDetectionGeneration) return
    detecting = true
    try {
      const { onlyActiveDevice = false, sysProxy = { enable: false } } = await getAppConfig()
      if (generation !== networkDetectionGeneration) return
      if (isAnyNetworkInterfaceUp(extendedBypass) && net.isOnline()) {
        if (controller.shouldStartCore(networkDownHandled)) {
          await controller.startCore()
          if (generation !== networkDetectionGeneration) return
          if (sysProxy.enable) await triggerSysProxy(true, onlyActiveDevice)
          networkDownHandled = false
        }
        if (generation !== networkDetectionGeneration) return
        await controller.reconcileDNS?.()
      } else if (!networkDownHandled) {
        if (sysProxy.enable) await triggerSysProxy(false, onlyActiveDevice, true)
        if (generation !== networkDetectionGeneration) return
        await controller.stopCore()
        if (generation === networkDetectionGeneration) {
          networkDownHandled = true
        }
      }
    } catch (error) {
      appendAppLog(`[Network]: network detection failed, ${error}\n`).catch(() => {})
    } finally {
      detecting = false
    }
  }, networkDetectionInterval * 1000)
}

export function stopNetworkDetection(): void {
  networkDetectionGeneration++
  if (networkDetectionTimer) {
    clearInterval(networkDetectionTimer)
    networkDetectionTimer = null
  }
}

function isAnyNetworkInterfaceUp(excludedKeywords: string[] = []): boolean {
  const interfaces = os.networkInterfaces()
  return Object.entries(interfaces).some(([name, ifaces]) => {
    if (excludedKeywords.some((keyword) => name.includes(keyword))) return false

    return ifaces?.some((iface) => {
      return !iface.internal && (iface.family === 'IPv4' || iface.family === 'IPv6')
    })
  })
}

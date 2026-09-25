import { execFile } from 'child_process'
import { net } from 'electron'
import os from 'os'
import { promisify } from 'util'
import { getAppConfig, getControledMihomoConfig, patchAppConfig } from '../config'
import { setSysDns } from '../service/api'
import { triggerSysProxy } from '../sys/sysproxy'
import { appendAppLog } from '../utils/log'
import { getRuntimeConfig } from './factory'
import { mihomoConfig } from './mihomoApi'
import { createDNSResolverProbe } from './dns-resolver'
import { createDNSLifecycleMonitor } from './dns-monitor'
import {
  createDNSReconciler,
  type DNSReconcileOutcome
} from './dns-reconciliation'
import {
  createDNSLifecycle,
  normalizeDNS,
  resolveSystemDnsTarget,
  type DNSLifecycleState,
  type DNSWriteMode
} from './dns-lifecycle'
import {
  parseNetworkServiceOrder,
  resolvePhysicalNetworkOwner,
  type PhysicalNetworkOwner
} from './network-owner'

export interface NetworkCoreController {
  shouldStartCore: (networkDownHandled: boolean) => boolean
  startCore: () => Promise<void>
  stopCore: () => Promise<void>
  reconcileDNS?: () => Promise<unknown>
}

let networkDetectionTimer: NodeJS.Timeout | null = null
let networkDetectionGeneration = 0
let networkDownHandled = false

let lastDNSStatus = ''
let physicalNetworkOwner: PhysicalNetworkOwner | undefined

const dnsLifecycle = createDNSLifecycle({
  readState: async (): Promise<DNSLifecycleState> => {
    const { originDNS, appliedDNS, targetService, appliedDNSMode, dnsOwnershipPhase } =
      await getAppConfig()
    return { originDNS, appliedDNS, targetService, appliedDNSMode, phase: dnsOwnershipPhase }
  },
  writeState: async (state) => {
    await patchAppConfig({
      originDNS: state.originDNS,
      appliedDNS: state.appliedDNS,
      targetService: state.targetService,
      appliedDNSMode: state.appliedDNSMode,
      dnsOwnershipPhase: state.phase
    })
  },
  getDefaultService,
  readDNS: getServiceDNS,
  writeDNS: setDNS
})

const resolverProbe = createDNSResolverProbe()

const dnsReconciler = createDNSReconciler({
  getMode: async () => (await getAppConfig()).autoSetDNSMode || 'none',
  isOnline: () => net.isOnline(),
  getRuntimeConfig: () => getRuntimeConfig(),
  getControllerConfig: () => mihomoConfig(),
  resolveTarget: (runtimeConfig, controllerConfig) =>
    resolveSystemDnsTarget(runtimeConfig, controllerConfig.tun),
  waitForResolver: waitForDNSResolver,
  apply: (target, mode) => dnsLifecycle.apply(target, mode),
  recover: (mode) => dnsLifecycle.recover(mode)
})

const dnsLifecycleMonitor = createDNSLifecycleMonitor({
  reconcile: () => reconcileSystemDNS(),
  getPhysicalOwner: async () => {
    const owner = await getPhysicalNetworkOwner()
    return owner ? ownerKey(owner) : undefined
  },
  initialPhysicalOwner: undefined,
  onOwnerChange: invalidateDNSReconciliation,
  onError: (error) => {
    appendAppLog(`[Network]: DNS lifecycle monitor failed, ${error}\n`).catch(() => {})
  }
})

async function readDefaultRouteDevice(): Promise<string | undefined> {
  const execFilePromise = promisify(execFile)
  try {
    const { stdout } = await execFilePromise('route', ['-n', 'get', 'default'])
    return stdout.match(/^\s*interface:\s*(\S+)\s*$/m)?.[1]
  } catch {
    return undefined
  }
}

export async function getDefaultDevice(): Promise<string> {
  const device = await readDefaultRouteDevice()
  if (!device) throw new Error('Get device failed')
  return device
}

async function readPhysicalNetworkSnapshot(): Promise<{
  defaultDevice?: string
  activeDevices: string[]
  services: ReturnType<typeof parseNetworkServiceOrder>
}> {
  const execFilePromise = promisify(execFile)
  const [defaultDevice, { stdout: serviceOrder }, { stdout: networkInfo }] = await Promise.all([
    readDefaultRouteDevice(),
    execFilePromise('networksetup', ['-listnetworkserviceorder']),
    execFilePromise('scutil', ['--nwi'])
  ])
  const activeInterfaces = networkInfo.match(/^Network interfaces:\s*(.*)$/m)?.[1].trim()
  const activeDevices =
    activeInterfaces && activeInterfaces !== 'none' ? activeInterfaces.split(/\s+/) : []

  return {
    defaultDevice,
    activeDevices,
    services: parseNetworkServiceOrder(serviceOrder)
  }
}

async function getPhysicalNetworkOwner(): Promise<PhysicalNetworkOwner | undefined> {
  const snapshot = await readPhysicalNetworkSnapshot()
  let previous = physicalNetworkOwner
  if (!previous) {
    const { targetService } = await getAppConfig()
    const persistedService = snapshot.services.find((service) => service.name === targetService)
    if (persistedService) {
      previous = { device: persistedService.device, service: persistedService.name }
    }
  }
  physicalNetworkOwner = resolvePhysicalNetworkOwner(snapshot, previous)
  return physicalNetworkOwner
}

export async function capturePhysicalNetworkOwner(): Promise<void> {
  if (process.platform !== 'darwin') return
  await getPhysicalNetworkOwner()
}

async function getDefaultService(): Promise<string> {
  const owner = await getPhysicalNetworkOwner()
  if (!owner) throw new Error('Unable to identify the active physical network service')
  return owner.service
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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    const timer = setTimeout(finish, ms)
    signal.addEventListener('abort', finish, { once: true })
  })
}

async function waitForDNSResolver(address: string, signal: AbortSignal): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt++) {
    if (signal.aborted) return false
    if (await resolverProbe(address, signal)) return true
    if (attempt < 3) {
      await abortableDelay(250, signal)
    }
  }
  return false
}

function reportDNSStatus(status: string): void {
  if (lastDNSStatus === status) return
  lastDNSStatus = status
  appendAppLog(`[Network]: ${status}\n`).catch(() => {})
}

export async function reconcileSystemDNS(): Promise<DNSReconcileOutcome> {
  if (process.platform !== 'darwin') return { kind: 'recovered' }

  const outcome = await dnsReconciler.reconcile()
  if (outcome.kind === 'not-ready') {
    reportDNSStatus('Mihomo controller or DNS resolver is not ready; deferred system DNS reconcile')
  } else if (outcome.kind === 'applied' || outcome.kind === 'recovered') {
    lastDNSStatus = ''
  }
  return outcome
}

export async function recoverDNS(): Promise<void> {
  if (process.platform !== 'darwin') return
  invalidateDNSReconciliation()
  const { autoSetDNSMode = 'none' } = await getAppConfig()
  await dnsReconciler.recover(autoSetDNSMode)
}

export function invalidateDNSReconciliation(): void {
  dnsReconciler.invalidate()
}

function ownerKey(owner: PhysicalNetworkOwner | undefined): string {
  return owner ? `${owner.device}\0${owner.service}` : ''
}

export function startDNSReconciliationMonitor(): void {
  if (process.platform !== 'darwin') return
  dnsLifecycleMonitor.start()
}

export function scheduleDNSReconciliation(): void {
  dnsLifecycleMonitor.schedule()
}

export function stopDNSReconciliationMonitor(): void {
  dnsLifecycleMonitor.stop()
  invalidateDNSReconciliation()
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

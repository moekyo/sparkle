import { execFile, spawn } from 'child_process'
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
import { createDNSReconciler, type DNSReconcileOutcome } from './dns-reconciliation'
import {
  createDNSLifecycle,
  normalizeDNS,
  resolveSystemDnsTarget,
  type DNSLifecycleState,
  type DNSWriteMode
} from './dns-lifecycle'
import {
  parseNetworkServiceOrder,
  parsePrimaryPhysicalService,
  resolvePhysicalNetworkOwner,
  type PhysicalNetworkOwner
} from './network-owner'
import { sameDNSOwner, type DNSOwnerToken } from './dns-owner'
import { dnsOwnerStore } from './dns-owner-store'

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
let dnsOwnerToken: DNSOwnerToken | undefined
let dnsMonitorOwnerToken: DNSOwnerToken | undefined

const dnsLifecycle = createDNSLifecycle({
  readState: async (): Promise<DNSLifecycleState> => {
    const { originDNS, appliedDNS, targetService, appliedDNSMode, dnsOwnershipPhase } =
      await getAppConfig(true)
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
  writeDNS: setDNS,
  isOwnerCurrent: isDNSOwnerCurrent
})

const resolverProbe = createDNSResolverProbe()

const dnsReconciler = createDNSReconciler({
  getMode: async () => (await getAppConfig(true)).autoSetDNSMode || 'none',
  isOnline: () => net.isOnline(),
  getRuntimeConfig: () => getRuntimeConfig(),
  getControllerConfig: () => mihomoConfig(),
  resolveTarget: (runtimeConfig, controllerConfig) =>
    resolveSystemDnsTarget(runtimeConfig, controllerConfig.tun),
  waitForResolver: waitForDNSResolver,
  apply: (target, mode, owner) => dnsLifecycle.apply(target, mode, owner),
  recover: (mode, owner) => dnsLifecycle.recover(mode, owner),
  isOwnerCurrent: isDNSOwnerCurrent,
  isServiceOwnerKnown: async () => !!(await getPhysicalNetworkOwner())
})

const dnsLifecycleMonitor = createDNSLifecycleMonitor({
  reconcile: () => reconcileSystemDNS(dnsMonitorOwnerToken),
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
  primaryDevice?: string
  primaryService?: string
  activeDevices: string[]
  services: ReturnType<typeof parseNetworkServiceOrder>
}> {
  const execFilePromise = promisify(execFile)
  const [defaultDevice, { stdout: serviceOrder }, { stdout: networkInfo }, primary] =
    await Promise.all([
      readDefaultRouteDevice(),
      execFilePromise('networksetup', ['-listnetworkserviceorder']),
      execFilePromise('scutil', ['--nwi']),
      readPrimaryPhysicalService()
    ])
  const activeInterfaces = networkInfo.match(/^Network interfaces:\s*(.*)$/m)?.[1].trim()
  const activeDevices =
    activeInterfaces && activeInterfaces !== 'none' ? activeInterfaces.split(/\s+/) : []

  return {
    defaultDevice,
    primaryDevice: primary?.device,
    primaryService: primary?.service,
    activeDevices,
    services: parseNetworkServiceOrder(serviceOrder)
  }
}

async function runScutil(commands: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('scutil', [], { stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk))
    child.once('error', reject)
    child.once('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `scutil exited with code ${code}`))
    })
    child.stdin.end([...commands, 'quit'].join('\n') + '\n')
  })
}

async function readPrimaryPhysicalService(): Promise<PhysicalNetworkOwner | undefined> {
  const [ipv4, ipv6] = await Promise.all([
    runScutil(['show State:/Network/Global/IPv4']),
    runScutil(['show State:/Network/Global/IPv6'])
  ])
  for (const globalState of [ipv4, ipv6]) {
    const serviceId = globalState.match(/^\s*PrimaryService\s*:\s*(\S+)\s*$/m)?.[1]
    if (!serviceId) continue
    const setupInterface = await runScutil([`show Setup:/Network/Service/${serviceId}/Interface`])
    const owner = parsePrimaryPhysicalService(globalState, setupInterface)
    if (owner) return owner
  }
  return undefined
}

async function getPhysicalNetworkOwner(): Promise<PhysicalNetworkOwner | undefined> {
  const snapshot = await readPhysicalNetworkSnapshot()
  physicalNetworkOwner = resolvePhysicalNetworkOwner(snapshot, physicalNetworkOwner)
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

export async function getServiceDNSForOwner(service: string): Promise<string> {
  return getServiceDNS(service)
}

export async function getDNSOwnershipSnapshot(): Promise<{
  targetService?: string
  originDNS?: string
  appliedDNS?: string
  appliedDNSMode?: DNSWriteMode
}> {
  const { targetService, originDNS, appliedDNS, appliedDNSMode } = await getAppConfig(true)
  return { targetService, originDNS, appliedDNS, appliedDNSMode }
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

export async function reconcileSystemDNS(
  owner: DNSOwnerToken | undefined = dnsOwnerToken
): Promise<DNSReconcileOutcome> {
  if (process.platform !== 'darwin') return { kind: 'recovered' }
  if (!owner || !(await isDNSOwnerCurrent(owner))) return { kind: 'stale' }

  const outcome = await dnsReconciler.reconcile(owner)
  if (outcome.kind === 'applied' || outcome.kind === 'recovered') {
    await syncDetachedDNSOwnerSnapshot(owner)
  }
  if (outcome.kind === 'not-ready') {
    reportDNSStatus('Mihomo controller or DNS resolver is not ready; deferred system DNS reconcile')
  } else if (outcome.kind === 'applied' || outcome.kind === 'recovered') {
    lastDNSStatus = ''
  }
  return outcome
}

export async function recoverDNS(owner: DNSOwnerToken | undefined = dnsOwnerToken): Promise<void> {
  if (process.platform !== 'darwin') return
  if (!owner) return
  invalidateDNSReconciliation()
  await dnsLifecycle.drain()
  const { autoSetDNSMode = 'none' } = await getAppConfig(true)
  await dnsReconciler.recover(autoSetDNSMode, owner)
}

export function invalidateDNSReconciliation(): void {
  dnsReconciler.invalidate()
}

export function setDNSOwnerToken(owner: DNSOwnerToken | undefined): void {
  if (!sameDNSOwner(dnsOwnerToken, owner)) invalidateDNSReconciliation()
  dnsOwnerToken = owner
}

export function getDNSOwnerToken(): DNSOwnerToken | undefined {
  return dnsOwnerToken
}

export async function drainDNSLifecycle(): Promise<void> {
  invalidateDNSReconciliation()
  await dnsLifecycle.drain()
}

export async function syncDetachedDNSOwnerSnapshot(owner: DNSOwnerToken): Promise<void> {
  const store = dnsOwnerStore()
  const record = await store.read()
  if (!record || !sameDNSOwner(record.owner, owner) || !record.detached) return
  const appConfig = await getAppConfig(true)
  await store.write({
    ...record,
    detached: {
      ...record.detached,
      targetService: appConfig.targetService,
      originDNS: appConfig.originDNS,
      appliedDNS: appConfig.appliedDNS,
      appliedDNSMode: appConfig.appliedDNSMode
    }
  })
}

function ownerKey(owner: PhysicalNetworkOwner | undefined): string {
  return owner ? `${owner.device}\0${owner.service}` : ''
}

export function startDNSReconciliationMonitor(): void {
  if (process.platform !== 'darwin') return
  dnsMonitorOwnerToken = dnsOwnerToken
  dnsLifecycleMonitor.start()
}

export function startDNSGuardianMonitor(owner: DNSOwnerToken): void {
  if (process.platform !== 'darwin') return
  dnsMonitorOwnerToken = owner
  dnsLifecycleMonitor.start()
}

export function scheduleDNSReconciliation(): void {
  dnsLifecycleMonitor.schedule()
}

export function stopDNSReconciliationMonitor(): void {
  dnsLifecycleMonitor.stop()
  dnsMonitorOwnerToken = undefined
  invalidateDNSReconciliation()
}

async function isDNSOwnerCurrent(owner: DNSOwnerToken): Promise<boolean> {
  const record = await dnsOwnerStore().read()
  return !!record && sameDNSOwner(record.owner, owner)
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

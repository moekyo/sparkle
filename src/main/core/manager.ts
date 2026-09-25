import { ChildProcess, spawn } from 'child_process'
import { createInterface } from 'readline'
import { dataDir, coreLogPath, mihomoCorePath } from '../utils/dirs'
import { systemCoreOnlyBuild } from '../../shared/build-flags'
import { generateProfile, getRuntimeConfig } from './factory'
import {
  getAppConfig,
  getControledMihomoConfig,
  getProfileConfig,
  patchAppConfig,
  patchControledMihomoConfig
} from '../config'
import { app, ipcMain } from 'electron'
import {
  startMihomoTraffic,
  startMihomoConnections,
  startMihomoLogs,
  startMihomoMemory,
  patchMihomoConfig,
  mihomoGroups,
  getAxios
} from './mihomoApi'
import { readFile, rename, rm, writeFile } from 'fs/promises'
import { mainWindow } from '..'
import path from 'path'
import os from 'os'
import { uploadRuntimeConfig } from '../resolve/gistApi'
import {
  getCoreStatus,
  startCore as startServiceCore,
  stopCore as stopServiceCore,
  isServiceConnectionError,
  isServiceUnavailableError,
  type ServiceCoreLaunchProfile
} from '../service/api'
import { serviceStatus } from '../service/manager'
import { clearAppUpdateServiceFallbackPause, getServiceFallbackPolicy } from '../service/fallback'
import { appendAppLog, createLogWritable, setMihomoLogSource } from '../utils/log'
import {
  dismissNotification,
  showNotification,
  type AppNotificationPayload,
  type AppNotificationVariant
} from '../utils/notification'
import { createCoreHookWaiter, createCoreStartupHook } from './startupHook'
import {
  isProcessCommandMatching,
  processIsAlive,
  readProcessIdentity,
  stopChildProcess,
  systemOwnedProcessControl
} from './process-control'
import {
  capturePhysicalNetworkOwner,
  drainDNSLifecycle,
  reconcileSystemDNS,
  recoverDNS,
  getDNSOwnerToken,
  getDNSOwnershipSnapshot,
  setDNSOwnerToken,
  startDNSReconciliationMonitor,
  startNetworkDetectionController,
  syncDetachedDNSOwnerSnapshot,
  stopDNSReconciliationMonitor,
  stopNetworkDetection
} from './network'
import { checkProfile } from './profile-check'
import {
  createCoreEnvironment,
  createCoreSpawnArgs,
  createProviderInitializationTracker,
  isControllerListenError,
  isControllerReadyLog,
  isTunPermissionError,
  isUpdaterFinishedLog
} from './startup-chain'
import { createServiceCoreRuntime } from './service-core-runtime'
import {
  reconcileDNSWhenControllerReady,
  runDetachedCoreDNSHandoff,
  waitForControllerReady,
  type CoreStartOptions,
  type CoreStopOptions
} from './core-lifecycle'
import { createDNSOwnerToken, sameDNSOwner, type DNSOwnerToken } from './dns-owner'
import { dnsOwnerStore } from './dns-owner-store'
import { createDNSOwnerCoordinator } from './dns-owner-coordinator'

const ctlParam = process.platform === 'win32' ? '-ext-ctl-pipe' : '-ext-ctl-unix'

const serviceConnectionRetryInterval = 500
const tailscaleAuthNotificationKeyPrefix = 'tailscale-auth:'
const directCoreLogLineLimit = 16 * 1024

const directCoreState = {
  child: undefined as ChildProcess | undefined,
  detached: false,
  retry: 10,
  logLineBuffer: ''
}

const serviceCoreRuntime = createServiceCoreRuntime({
  notifyCoreLog,
  resetDirectCoreRetry: () => {
    directCoreState.retry = 10
  },
  startCore: (options) => startCore(options)
})

type CoreLogNotification = AppNotificationPayload & {
  key: string
  name?: string
  variant?: AppNotificationVariant
}

interface CoreLogAction {
  closeName: string
}

interface CoreLogNotificationSource {
  message?: string
  data?: Record<string, string>
  text?: string
}

interface CoreLogNotificationRule {
  match: (source: CoreLogNotificationSource) => CoreLogNotification | CoreLogAction | undefined
}

const notifiedCoreLogKeys = new Set<string>()
const tailscaleAuthNotificationKeysByName = new Map<string, Set<string>>()
const coreLogNotificationRules: CoreLogNotificationRule[] = [
  {
    match: (source) => {
      const doneName =
        source.message === 'tailscale_auth_done'
          ? source.data?.name
          : source.text
            ? parseTailscaleAuthDoneLog(source.text)
            : undefined
      if (doneName) {
        return { closeName: doneName }
      }

      const auth =
        source.message === 'tailscale_auth'
          ? source.data
          : source.text
            ? parseTailscaleAuthLog(source.text)
            : undefined

      const name = auth?.name
      const url = auth?.url
      if (!name || !url) return undefined

      return {
        key: `${tailscaleAuthNotificationKeyPrefix}${url}`,
        name,
        id: `${tailscaleAuthNotificationKeyPrefix}${url}`,
        title: `${name} 需要 Tailscale 认证`,
        body: '点击打开认证链接',
        persistent: true,
        url,
        variant: 'warning'
      }
    }
  }
]

function parseTailscaleAuthLog(line: string): { name: string; url: string } | undefined {
  const prefix = '[Tailscale]('
  const marker = ') To start this tsnet server, restart with TS_AUTHKEY set, or go to: '
  const prefixIndex = line.indexOf(prefix)
  if (prefixIndex < 0) return undefined

  const rest = line.slice(prefixIndex + prefix.length)
  const markerIndex = rest.indexOf(marker)
  if (markerIndex <= 0) return undefined

  const name = rest.slice(0, markerIndex)
  let url = rest.slice(markerIndex + marker.length).trim()
  const urlEnd = findTailscaleAuthUrlEnd(url)
  if (urlEnd >= 0) {
    url = url.slice(0, urlEnd)
  }

  if (!name || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return undefined
  }

  return { name, url }
}

function parseTailscaleAuthDoneLog(line: string): string | undefined {
  const prefix = '[Tailscale]('
  const marker = ') AuthLoop: state is Starting; done'
  const prefixIndex = line.indexOf(prefix)
  if (prefixIndex < 0) return undefined

  const rest = line.slice(prefixIndex + prefix.length)
  const markerIndex = rest.indexOf(marker)
  if (markerIndex <= 0) return undefined

  return rest.slice(0, markerIndex) || undefined
}

function findTailscaleAuthUrlEnd(url: string): number {
  for (let index = 0; index < url.length; index++) {
    const code = url.charCodeAt(index)
    if (
      code <= 32 ||
      url[index] === '"' ||
      url[index] === "'" ||
      url[index] === '<' ||
      url[index] === '>'
    ) {
      return index
    }
  }

  return -1
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

type ServiceCoreConnectionProbe = {
  reachable: boolean
  running: boolean
  error: unknown
}

async function startMihomoApiStreams(): Promise<void> {
  await startMihomoTraffic()
  await startMihomoConnections()
  await startMihomoLogs()
  await startMihomoMemory()
  directCoreState.retry = 10
}

async function completeCoreInitialization(logLevel?: LogLevel): Promise<void> {
  const tasks: Promise<unknown>[] = [
    delay(100).then(() => {
      mainWindow?.webContents.send('groupsUpdated')
      mainWindow?.webContents.send('rulesUpdated')
    }),
    (async () => {
      try {
        await uploadRuntimeConfig()
      } catch (error) {
        await appendAppLog(`[Manager]: upload runtime config failed, ${error}\n`)
        void showNotification({
          title: '同步 Gist 配置失败',
          body: `${error}`,
          variant: 'danger'
        })
      }
    })()
  ]

  if (logLevel) {
    tasks.push(
      delay(100)
        .then(() => patchMihomoConfig({ 'log-level': logLevel }))
        .catch((error) =>
          appendAppLog(`[Manager]: update core log level failed, ${error}\n`).catch(() => {})
        )
    )
  }

  setMihomoLogSource('ws')
  void Promise.all(tasks).catch((error) => {
    appendAppLog(`[Manager]: post-start tasks failed, ${error}\n`).catch(() => {})
  })
  await reconcileDNSWhenControllerReady(waitForMihomoReady, reconcileSystemDNS, (error) => {
    appendAppLog(
      error
        ? `[Manager]: DNS reconcile deferred, ${error}\n`
        : '[Manager]: controller not ready; DNS reconcile deferred\n'
    ).catch(() => {})
  })
  startDNSReconciliationMonitor()
}

async function waitForMihomoReady(): Promise<boolean> {
  return waitForControllerReady(() => mihomoGroups(), {
    maxRetries: 30,
    retryIntervalMs: 100,
    delay
  })
}

function startMihomoApiStreamsBestEffort(): void {
  startMihomoApiStreams().catch((error) => {
    appendAppLog(`[Manager]: start controller streams deferred, ${error}\n`).catch(() => {})
  })
}

async function waitForServiceCoreConnection(
  initialError: unknown
): Promise<ServiceCoreConnectionProbe> {
  await appendAppLog(
    `[Manager]: Service connection failed, waiting before fallback, ${initialError}\n`
  )

  const fallbackPolicy = getServiceFallbackPolicy()
  const { pausedForAppUpdate, connectionRetryTimeout } = fallbackPolicy

  if (!isServiceConnectionError(initialError) && !pausedForAppUpdate) {
    return { reachable: false, running: false, error: initialError }
  }

  const status = await getServiceStatusAfterConnectionError()
  if (status && status !== 'running') {
    if (!pausedForAppUpdate) {
      await appendAppLog(`[Manager]: Service status is ${status}, fallback immediately\n`)
      return { reachable: false, running: false, error: initialError }
    }
    await appendAppLog(`[Manager]: Service status is ${status} during app update, keep waiting\n`)
  }

  const startedAt = Date.now()
  let lastError = initialError

  while (Date.now() - startedAt < connectionRetryTimeout) {
    await delay(serviceConnectionRetryInterval)

    try {
      await getCoreStatus()
      if (pausedForAppUpdate) {
        await clearAppUpdateServiceFallbackPause()
      }
      return { reachable: true, running: true, error: lastError }
    } catch (error) {
      lastError = error
      if (isServiceUnavailableError(error) && !isServiceConnectionError(error)) {
        if (!pausedForAppUpdate) {
          return { reachable: false, running: false, error }
        }
        continue
      }
      if (!isServiceConnectionError(error)) {
        return { reachable: true, running: false, error }
      }
    }
  }

  await appendAppLog(
    `[Manager]: Service still unavailable after ${connectionRetryTimeout}ms, ${lastError}\n`
  )
  return { reachable: false, running: false, error: lastError }
}

async function getServiceStatusAfterConnectionError(): Promise<
  Awaited<ReturnType<typeof serviceStatus>> | undefined
> {
  try {
    return await serviceStatus()
  } catch (error) {
    await appendAppLog(`[Manager]: query service status failed before fallback, ${error}\n`)
    return undefined
  }
}

interface PreparedCoreStart {
  options: CoreStartOptions
  appConfig: AppConfig
  logLevel?: LogLevel
  corePath: string
  serviceCoreRunning: boolean
  detached: boolean
  preserveDNSOwnership: boolean
  requiresDNS: boolean
  useServiceCore: boolean
  env: Record<string, string | undefined>
  safePaths: string[]
  coreHook?: Awaited<ReturnType<typeof createCoreStartupHook>>
  hookWaiter?: ReturnType<typeof createCoreHookWaiter>
  spawnArgs: string[]
  providerTracker: ReturnType<typeof createProviderInitializationTracker>
}

type CorePreparationResult =
  { kind: 'ready'; prepared: PreparedCoreStart } | { kind: 'service-fallback'; error: unknown }

async function prepareCoreStart(
  options: CoreStartOptions,
  profilePrepared = false
): Promise<CorePreparationResult> {
  const detached = options.mode === 'detached'
  const preserveDNSOwnership = options.dnsOwnership === 'preserve' || detached
  const [appConfig, controlledMihomoConfig, profileConfig] = await Promise.all([
    getAppConfig(),
    getControledMihomoConfig(),
    getProfileConfig()
  ])
  const {
    core = 'mihomo',
    corePermissionMode = 'elevated',
    coreStartupMode = 'post-up',
    diffWorkDir = false,
    disableLoopbackDetector = false,
    disableEmbedCA = false,
    disableSystemCA = false,
    disableNftables = false,
    safePaths = []
  } = appConfig
  const { 'log-level': logLevel } = controlledMihomoConfig
  const { current } = profileConfig
  const useServiceCore = corePermissionMode === 'service' && !detached

  let corePath: string
  try {
    corePath = mihomoCorePath(core)
  } catch (error) {
    if (core === 'system' && !systemCoreOnlyBuild) {
      await patchAppConfig({ core: 'mihomo' })
      return prepareCoreStart(options, profilePrepared)
    }
    throw error
  }

  if (!profilePrepared) await generateProfile()
  if (useServiceCore || detached) {
    await checkProfile()
  }
  try {
    await capturePhysicalNetworkOwner()
  } catch (error) {
    await appendAppLog(`[Manager]: capture physical network owner failed, ${error}\n`)
  }
  let serviceCoreRunning = false
  if (useServiceCore) {
    try {
      await getCoreStatus()
      serviceCoreRunning = true
    } catch (error) {
      if (isServiceUnavailableError(error)) {
        const probe = await waitForServiceCoreConnection(error)
        if (!probe.reachable) {
          return { kind: 'service-fallback', error: probe.error }
        }
        serviceCoreRunning = probe.running
      }
    }
  }
  const env = createCoreEnvironment({
    disableLoopbackDetector,
    disableEmbedCA,
    disableSystemCA,
    disableNftables,
    safePaths
  })

  const coreHook =
    !useServiceCore && !detached && coreStartupMode === 'post-up'
      ? await createCoreStartupHook()
      : undefined
  const hookWaiter = coreHook ? createCoreHookWaiter(coreHook) : undefined
  if (coreHook) {
    await appendAppLog(
      `[Manager]: Core startup mode: post-up, post-up command: ${coreHook.postUpCommand}\n`
    )
  } else if (!detached) {
    await appendAppLog(`[Manager]: Core startup mode: log\n`)
  }

  const spawnArgs = createCoreSpawnArgs({
    current,
    diffWorkDir,
    ctlParam,
    coreHook
  })

  const runtimeConfig = await getRuntimeConfig()
  const providerTracker = createProviderInitializationTracker(runtimeConfig)
  return {
    kind: 'ready',
    prepared: {
      options,
      appConfig,
      logLevel,
      corePath,
      serviceCoreRunning,
      detached,
      preserveDNSOwnership,
      requiresDNS:
        detached &&
        Boolean(appConfig.autoSetDNSMode && appConfig.autoSetDNSMode !== 'none') &&
        runtimeConfig.tun?.enable === true &&
        runtimeConfig.dns?.enable !== false,
      useServiceCore,
      env,
      safePaths,
      coreHook,
      hookWaiter,
      spawnArgs,
      providerTracker
    }
  }
}

export async function startCore(options: CoreStartOptions = {}): Promise<Promise<void>[]> {
  if (options.mode !== 'detached') await ensureManagedDNSOwner()
  const preparation = await prepareCoreStart(options)
  if (preparation.kind === 'service-fallback') {
    return serviceCoreRuntime.fallbackToElevatedCore(options, preparation.error)
  }
  return startPreparedCore(preparation.prepared)
}

async function ensureManagedDNSOwner(): Promise<DNSOwnerToken> {
  const store = dnsOwnerStore()
  const coordinator = createDNSOwnerCoordinator({
    store,
    isProcessAlive: async (pid) => processIsAlive(pid),
    isOwnerProcessAlive: async (owner) =>
      !!owner.startedAt &&
      processIsAlive(owner.pid) &&
      readProcessIdentity(owner.pid) === owner.startedAt,
    getProcessIdentity: async (pid) => readProcessIdentity(pid),
    isGuardianAlive: async (record) => {
      const guardianPid = record.detached?.guardianPid
      const generation = record.detached?.generation
      return !!(
        guardianPid &&
        generation &&
        processIsAlive(guardianPid) &&
        isProcessCommandMatching(guardianPid, `--sparkle-dns-guardian=${generation}`)
      )
    },
    requestGuardianRelease: async (record) => {
      const detached = record.detached
      if (!detached) throw new Error('Detached DNS guardian state is missing')
      const request = {
        type: 'relaunch' as const,
        requestId: createDNSOwnerToken('detached-guardian').generation,
        requestedBy: process.pid
      }
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        const current = await store.read()
        if (
          !current ||
          current.detached?.generation !== detached.generation ||
          !sameDNSOwner(current.owner, record.owner)
        ) {
          return
        }
        if (!processIsAlive(detached.guardianPid)) return
        await store.write({
          ...current,
          detached: { ...current.detached, request }
        })
        await delay(200)
      }
      throw new Error('Timed out waiting for the detached DNS guardian to release ownership')
    },
    stopDetachedCore: async (record) => {
      const detached = record.detached
      if (!detached?.corePid) return
      if (!detached.coreStartedAt) {
        throw new Error('Detached core identity is missing; refusing to signal an unknown process')
      }
      await systemOwnedProcessControl().stop(detached.corePid, detached.coreStartedAt)
      await removeCorePid(detached.corePid)
    },
    recoverDNS: (owner) => recoverDNS(owner)
  })
  const owner = await coordinator.acquireManagedOwner(process.pid)
  setDNSOwnerToken(owner)
  return owner
}

async function writeCorePid(pid: number): Promise<void> {
  const filePath = path.join(dataDir(), 'core.pid')
  const temporaryPath = `${filePath}.${process.pid}.tmp`
  await writeFile(temporaryPath, `${pid}\n`, { mode: 0o600 })
  await rename(temporaryPath, filePath)
}

async function removeCorePid(expectedPid?: number): Promise<void> {
  const filePath = path.join(dataDir(), 'core.pid')
  try {
    const currentPid = Number.parseInt((await readFile(filePath, 'utf8')).trim(), 10)
    if (
      !Number.isInteger(currentPid) ||
      (expectedPid !== undefined && currentPid !== expectedPid)
    ) {
      return
    }
    await rm(filePath)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

async function startPreparedCore(
  prepared: PreparedCoreStart,
  onSpawn?: (pid: number) => Promise<void>
): Promise<Promise<void>[]> {
  const {
    options,
    appConfig,
    logLevel,
    corePath,
    serviceCoreRunning,
    detached,
    preserveDNSOwnership,
    useServiceCore,
    env,
    safePaths,
    coreHook,
    hookWaiter,
    spawnArgs,
    providerTracker
  } = prepared
  const {
    serviceRunMode = 'auto',
    serviceCpuAffinity = [],
    mihomoCpuPriority = 'PRIORITY_NORMAL',
    saveLogs = true,
    maxLogFileSizeMB = 20,
    coreStartupMode = 'post-up'
  } = appConfig
  let initialized = false

  if (!serviceCoreRunning && options.existingCore !== 'already-stopped') {
    await stopCore({ dnsOwnership: preserveDNSOwnership ? 'preserve' : 'restore' })
  } else if (options.existingCore === 'already-stopped') {
    stopDNSReconciliationMonitor()
  }
  setMihomoLogSource('out')
  if (coreHook) {
    await appendAppLog(
      `[Manager]: Core startup mode: post-up, post-up command: ${coreHook.postUpCommand}\n`
    )
  } else if (!detached) {
    await appendAppLog(`[Manager]: Core startup mode: log\n`)
  }

  if (useServiceCore) {
    const serviceProfile: ServiceCoreLaunchProfile = {
      core_path: corePath,
      args: spawnArgs,
      mode: serviceRunMode,
      safe_paths: safePaths,
      cpu_affinity: serviceCpuAffinity,
      env,
      mihomo_cpu_priority: mihomoCpuPriority,
      log_path: coreLogPath(),
      save_logs: saveLogs,
      max_log_file_size_mb: maxLogFileSizeMB
    }

    await appendAppLog(`[Manager]: Core permission mode: service\n`)
    serviceCoreRuntime.resumeAutoResume()
    serviceCoreRuntime.ensureEventHandler()
    serviceCoreRuntime.beginStartup()
    try {
      await serviceCoreRuntime.startEventStream()
      if (!serviceCoreRunning) {
        await startServiceCore(serviceProfile)
      }
      serviceCoreRuntime.setManaged(true)
    } catch (error) {
      if (isServiceUnavailableError(error)) {
        const probe = await waitForServiceCoreConnection(error)
        if (!probe.reachable) {
          return serviceCoreRuntime.fallbackToElevatedCore(options, probe.error)
        }
        await serviceCoreRuntime.startEventStream()
        if (!probe.running) {
          await startServiceCore(serviceProfile)
        }
        serviceCoreRuntime.setManaged(true)
      } else {
        throw error
      }
    } finally {
      serviceCoreRuntime.endStartup()
    }
    void serviceCoreRuntime.ensureStreamsStarted().catch((error) => {
      appendAppLog(`[Manager]: start service core streams deferred, ${error}\n`).catch(() => {})
    })
    initialized = true
    return [completeCoreInitialization(logLevel)]
  }

  const stdout = createLogWritable('core', 'info')
  const stderr = createLogWritable('core', 'error')
  directCoreState.logLineBuffer = ''

  const child = spawn(corePath, spawnArgs, {
    detached: detached,
    stdio: detached ? 'ignore' : undefined,
    env: env
  })
  directCoreState.child = child
  directCoreState.detached = detached
  let startupOutput = ''
  let configurationRejected = false
  let spawnError: Error | undefined
  const captureStartupOutput = (data: Buffer): void => {
    if (initialized) return
    startupOutput += data.toString()
    configurationRejected ||= startupOutput.includes('Parse config error:')
    startupOutput = startupOutput.slice(-16384)
  }
  child.stdout?.on('data', captureStartupOutput)
  child.stderr?.on('data', captureStartupOutput)
  child.once('error', (error) => {
    spawnError = error
  })
  const startupFailure = (reason: unknown): Error => {
    const details = startupOutput.trim()
    return new Error(
      `内核启动失败：${spawnError?.message || String(reason)}${details ? `\n${details}` : ''}`
    )
  }
  hookWaiter?.attachProcess(child)
  if (child.pid) {
    try {
      os.setPriority(child.pid, os.constants.priority[mihomoCpuPriority])
    } catch (error) {
      const log = appendAppLog(`[Manager]: set core priority failed, ${error}\n`)
      if (detached) await log
      else void log.catch(() => {})
    }
  }
  if (detached) {
    child.unref()
    child.once('close', (code, signal) => {
      if (directCoreState.child === child) {
        directCoreState.child = undefined
        directCoreState.detached = false
      }
      appendAppLog(`[Manager]: Detached core closed, code: ${code}, signal: ${signal}\n`).catch(
        () => {}
      )
    })
    const childExited = new Promise<never>((_resolve, reject) => {
      child.once('close', (code, signal) => {
        reject(startupFailure(`code: ${code}, signal: ${signal}`))
      })
    })
    void childExited.catch(() => {})
    if (onSpawn) {
      if (!child.pid) throw new Error('Detached core process did not receive a PID')
      await onSpawn(child.pid)
    }
    const controllerReady = waitForControllerReady(() => mihomoGroups(), {
      maxRetries: 100,
      retryIntervalMs: 100,
      timeoutMs: 12000,
      delay
    }).then((ready) => {
      if (!ready) throw startupFailure('Mihomo controller did not become ready')
      if (spawnError || child.exitCode !== null || child.signalCode !== null) {
        throw startupFailure(spawnError || 'Detached core exited before becoming ready')
      }
    })
    await Promise.race([controllerReady, childExited])
    if (directCoreState.child !== child || child.exitCode !== null || child.signalCode !== null) {
      throw startupFailure('Detached core exited before DNS handoff')
    }
    if (options.reconcileDNSAfterReady !== false) {
      const outcome = await reconcileSystemDNS()
      if (outcome.kind === 'not-ready' || outcome.kind === 'stale') {
        throw startupFailure(`DNS resolver is not ready: ${outcome.kind}`)
      }
    }
    return []
  }
  child.once('close', async (code, signal) => {
    if (directCoreState.child === child) {
      directCoreState.child = undefined
      directCoreState.detached = false
    }
    flushDirectCoreLogNotifications()
    await appendAppLog(`[Manager]: Core closed, code: ${code}, signal: ${signal}\n`)
    if (!configurationRejected && directCoreState.retry) {
      await appendAppLog(`[Manager]: Try Restart Core\n`)
      directCoreState.retry--
      await restartCore()
    } else {
      await stopCore()
    }
  })
  child.stdout?.pipe(stdout)
  child.stderr?.pipe(stderr)
  child.stdout?.on('data', handleDirectCoreLogData)
  child.stderr?.on('data', handleDirectCoreLogData)

  const handleCoreOutput = async (
    str: string,
    reject: (reason?: unknown) => void
  ): Promise<void> => {
    if (isControllerListenError(str)) {
      reject(`控制器监听错误:\n${str}`)
    }

    if (isUpdaterFinishedLog(str)) {
      try {
        await stopCore()
        const promises = await startCore()
        await Promise.all(promises)
      } catch (e) {
        void showNotification({ title: '内核启动出错', body: `${e}`, variant: 'danger' })
      }
    }
  }

  const waitForCoreReadyByLog = (): Promise<Promise<void>[]> => {
    let controllerReady = false
    let providersReady = false
    let completing = false

    return new Promise((resolve, reject) => {
      if (!child.stdout) {
        reject(startupFailure('Core stdout is unavailable'))
        return
      }
      const lines = createInterface({ input: child.stdout })
      child.once('close', (code, signal) => {
        lines.close()
        reject(startupFailure(`code: ${code}, signal: ${signal}`))
      })

      lines.on('line', (line) => {
        const handleLine = async (): Promise<void> => {
          await handleCoreOutput(line, reject)
          if (initialized) return

          providerTracker.track(line)
          providersReady ||= providerTracker.isReady(line)
          controllerReady ||= isControllerReadyLog(line)

          if (isTunPermissionError(line)) {
            patchControledMihomoConfig({ tun: { enable: false } })
            mainWindow?.webContents.send('controledMihomoConfigUpdated')
            ipcMain.emit('updateTrayMenu')
            reject('虚拟网卡启动失败，前往内核设置页尝试手动授予内核权限')
            return
          }

          if (!controllerReady || !providersReady || completing) return
          completing = true
          startMihomoApiStreamsBestEffort()
          initialized = true
          resolve([completeCoreInitialization(logLevel)])
        }
        handleLine().catch(reject)
      })
    })
  }

  const waitForCoreReadyByHook = (): Promise<Promise<void>[]> => {
    if (!hookWaiter) return waitForCoreReadyByLog()

    return new Promise((resolve, reject) => {
      child.stdout?.on('data', (data) => {
        handleCoreOutput(data.toString(), reject).catch(reject)
      })

      hookWaiter.promise
        .then(async () => {
          initialized = true
          startMihomoApiStreamsBestEffort()
          resolve([completeCoreInitialization(logLevel)])
        })
        .catch((error) => reject(startupFailure(error)))
    })
  }

  return coreStartupMode === 'post-up' ? waitForCoreReadyByHook() : waitForCoreReadyByLog()
}

export async function stopCore(options: CoreStopOptions = {}): Promise<void> {
  stopDNSReconciliationMonitor()
  serviceCoreRuntime.pauseAutoResume()

  if (options.dnsOwnership !== 'preserve') {
    try {
      await recoverDNS()
    } catch (error) {
      await appendAppLog(`[Manager]: recover dns failed, ${error}\n`)
    }
  } else {
    await drainDNSLifecycle()
  }

  serviceCoreRuntime.clearStreams()

  const { corePermissionMode = 'elevated' } = await getAppConfig()
  const shouldStopServiceCore = serviceCoreRuntime.isManaged() || corePermissionMode === 'service'
  if (shouldStopServiceCore) {
    try {
      await stopServiceCore()
    } catch (error) {
      await appendAppLog(`[Manager]: stop service core failed, ${error}\n`)
    } finally {
      serviceCoreRuntime.setManaged(false)
      serviceCoreRuntime.stopEventHandlers()
    }
  }

  const child = directCoreState.child
  if (child) {
    directCoreState.child = undefined
    directCoreState.detached = false
    await stopChildProcess(child)
  }

  await getAxios(true).catch(() => {})

  try {
    const pid = Number.parseInt(
      (await readFile(path.join(dataDir(), 'core.pid'), 'utf8')).trim(),
      10
    )
    const ownerRecord = await dnsOwnerStore().read()
    const detached = ownerRecord?.detached
    if (Number.isInteger(pid) && detached?.corePid === pid && detached.coreStartedAt) {
      await systemOwnedProcessControl().stop(pid, detached.coreStartedAt)
    }
    await removeCorePid(Number.isInteger(pid) ? pid : undefined)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      await appendAppLog(`[Manager]: detached core cleanup failed, ${error}\n`)
    }
  }
}

function notifyCoreLog(source: CoreLogNotificationSource): void {
  for (const rule of coreLogNotificationRules) {
    const result = rule.match(source)
    if (!result) continue
    if ('closeName' in result) {
      clearTailscaleAuthNotifications(result.closeName)
      continue
    }

    const notification = result
    if (notifiedCoreLogKeys.has(notification.key)) continue

    notifiedCoreLogKeys.add(notification.key)
    if (notification.name) {
      const keys = tailscaleAuthNotificationKeysByName.get(notification.name) ?? new Set<string>()
      keys.add(notification.key)
      tailscaleAuthNotificationKeysByName.set(notification.name, keys)
    }
    const { key: _key, name: _name, ...payload } = notification
    void showNotification(payload)
  }
}

function handleDirectCoreLogData(data: Buffer | string): void {
  const text = data.toString().replaceAll('\r\n', '\n')
  const combined = directCoreState.logLineBuffer + text
  const lines = combined.split('\n')

  if (combined.endsWith('\n')) {
    directCoreState.logLineBuffer = ''
  } else {
    directCoreState.logLineBuffer = lines.pop() ?? ''
    if (directCoreState.logLineBuffer.length > directCoreLogLineLimit) {
      directCoreState.logLineBuffer = directCoreState.logLineBuffer.slice(-directCoreLogLineLimit)
    }
  }

  for (const line of lines) {
    notifyCoreLog({ text: line })
  }
}

function flushDirectCoreLogNotifications(): void {
  if (!directCoreState.logLineBuffer) return

  notifyCoreLog({ text: directCoreState.logLineBuffer })
  directCoreState.logLineBuffer = ''
}

function clearTailscaleAuthNotifications(name?: string): void {
  const indexedKeys = name ? tailscaleAuthNotificationKeysByName.get(name) : undefined
  const keys =
    indexedKeys ??
    new Set(
      Array.from(notifiedCoreLogKeys).filter((key) =>
        key.startsWith(tailscaleAuthNotificationKeyPrefix)
      )
    )
  if (keys.size === 0) return

  for (const key of keys) {
    notifiedCoreLogKeys.delete(key)
    dismissNotification(key)
  }

  if (name) {
    tailscaleAuthNotificationKeysByName.delete(name)
  } else {
    tailscaleAuthNotificationKeysByName.clear()
  }
}

export async function restartCore(): Promise<void> {
  try {
    clearTailscaleAuthNotifications()
    await stopCore()
    const promises = await startCore()
    await Promise.all(promises)
  } catch (e) {
    void showNotification({ title: '内核启动出错', body: `${e}`, variant: 'danger' })
  }
}

let detachedHandoffInProgress = false

export async function keepCoreAlive(): Promise<void> {
  const { corePermissionMode = 'elevated' } = await getAppConfig()
  if (corePermissionMode === 'service') return
  if (detachedHandoffInProgress) throw new Error('Detached core handoff is already in progress')
  detachedHandoffInProgress = true

  try {
    const previousOwner = getDNSOwnerToken()
    const managedOwner = await ensureManagedDNSOwner()
    if (previousOwner && !sameDNSOwner(previousOwner, managedOwner)) {
      throw new Error('Managed DNS owner changed before detached handoff')
    }
    const managedOwnerStartedAt = readProcessIdentity(process.pid)
    if (!managedOwnerStartedAt) throw new Error('Unable to identify the managed DNS owner process')
    const managedOwnerRecord = {
      ...managedOwner,
      pid: process.pid,
      startedAt: managedOwnerStartedAt
    }
    const guardianOwner = createDNSOwnerToken('detached-guardian')
    const store = dnsOwnerStore()
    let guardianProcess: ChildProcess | undefined
    let guardianSpawnError: Error | undefined
    let detachedCorePid: number | undefined
    let managedRollbackPrepared: PreparedCoreStart | undefined

    const prepare = async (
      options: CoreStartOptions,
      profilePrepared = false
    ): Promise<PreparedCoreStart> => {
      const result = await prepareCoreStart(options, profilePrepared)
      if (result.kind === 'service-fallback') {
        throw new Error(`Unable to prepare detached core: ${result.error}`)
      }
      return result.prepared
    }

    await runDetachedCoreDNSHandoff({
      prepareDetachedCore: async () => {
        const detachedPrepared = await prepare({
          mode: 'detached',
          dnsOwnership: 'preserve',
          existingCore: 'already-stopped',
          reconcileDNSAfterReady: false
        })
        managedRollbackPrepared = await prepare(
          {
            mode: 'managed',
            dnsOwnership: 'preserve',
            existingCore: 'already-stopped'
          },
          true
        )
        return detachedPrepared
      },
      requiresDNS: (prepared) => prepared.requiresDNS,
      prepareGuardian: async () => {
        const ownerRecord = await store.read()
        if (!ownerRecord || !sameDNSOwner(ownerRecord.owner, managedOwner)) {
          throw new Error('Managed DNS ownership changed before detached handoff')
        }
        const dnsSnapshot = await getDNSOwnershipSnapshot()
        await store.write({
          version: 1,
          owner: managedOwnerRecord,
          detached: {
            ...dnsSnapshot,
            generation: guardianOwner.generation,
            guardianPid: 0,
            status: 'preparing',
            ready: false
          }
        })

        const marker = `--sparkle-dns-guardian=${guardianOwner.generation}`
        guardianProcess = spawn(process.execPath, [app.getAppPath(), marker], {
          detached: true,
          stdio: 'ignore',
          env: process.env
        })
        guardianProcess.once('error', (error) => {
          guardianSpawnError = error
        })
        guardianProcess.unref()
        const guardianPid = guardianProcess.pid
        if (!guardianPid) throw new Error('DNS guardian process did not receive a PID')

        const current = await store.read()
        if (
          !current ||
          !sameDNSOwner(current.owner, managedOwner) ||
          current.detached?.generation !== guardianOwner.generation
        ) {
          throw new Error('DNS guardian registration was replaced during startup')
        }
        await store.write({
          ...current,
          detached: { ...current.detached, guardianPid }
        })

        const deadline = Date.now() + 15000
        while (Date.now() < deadline) {
          if (guardianSpawnError) throw guardianSpawnError
          if (guardianProcess.exitCode !== null || guardianProcess.signalCode !== null) {
            throw new Error('DNS guardian exited before becoming ready')
          }
          const registration = await store.read()
          if (
            registration?.detached?.generation !== guardianOwner.generation ||
            !sameDNSOwner(registration.owner, managedOwner)
          ) {
            throw new Error('DNS guardian registration was lost')
          }
          if (
            registration.detached.ready &&
            registration.detached.guardianPid === guardianPid &&
            processIsAlive(guardianPid) &&
            isProcessCommandMatching(guardianPid, marker)
          ) {
            return
          }
          await delay(100)
        }
        throw new Error('Timed out waiting for the detached DNS guardian to become ready')
      },
      stopManagedCorePreservingDNS: async () => {
        stopNetworkDetection()
        await stopCore({ dnsOwnership: 'preserve' })
      },
      startDetachedCore: async (prepared) => {
        const startPromises = await startPreparedCore(prepared, async (pid) => {
          detachedCorePid = pid
          const record = await store.read()
          if (
            !record ||
            !sameDNSOwner(record.owner, managedOwner) ||
            record.detached?.generation !== guardianOwner.generation
          ) {
            throw new Error('Detached core started after DNS guardian ownership was lost')
          }
          await store.write({
            ...record,
            detached: { ...record.detached, corePid: pid, corePath: prepared.corePath }
          })

          let startedAt: string | undefined
          for (let attempt = 0; attempt < 20 && !startedAt; attempt++) {
            startedAt = readProcessIdentity(pid)
            if (!startedAt) await delay(50)
          }
          if (!startedAt) throw new Error('Unable to identify the detached core process')
          const identified = await store.read()
          if (
            !identified ||
            !sameDNSOwner(identified.owner, managedOwner) ||
            identified.detached?.generation !== guardianOwner.generation
          ) {
            throw new Error('Detached core identity was not persisted under the active handoff')
          }
          await store.write({
            ...identified,
            detached: { ...identified.detached, coreStartedAt: startedAt }
          })
        })
        await Promise.all(startPromises)
      },
      reconcileDNS: async () => {
        if (!directCoreState.detached || !directCoreState.child) return { kind: 'not-ready' }
        const outcome = await reconcileSystemDNS(managedOwner)
        return directCoreState.detached && directCoreState.child ? outcome : { kind: 'not-ready' }
      },
      registerGuardian: async () => {
        const record = await store.read()
        if (
          !record ||
          !sameDNSOwner(record.owner, managedOwner) ||
          record.detached?.generation !== guardianOwner.generation ||
          !record.detached.ready ||
          !record.detached.corePid ||
          !record.detached.coreStartedAt
        ) {
          throw new Error('Detached DNS guardian is not durably registered')
        }
        await drainDNSLifecycle()
        await syncDetachedDNSOwnerSnapshot(managedOwner)
      },
      stopDetachedCorePreservingDNS: async () => {
        await stopCore({ dnsOwnership: 'preserve' })
        await removeCorePid(detachedCorePid)
      },
      recoverDNS: () => recoverDNS(managedOwner),
      revokeGuardian: async () => {
        const current = await store.read()
        if (current?.detached?.generation === guardianOwner.generation) {
          await store.write({
            version: 1,
            owner: managedOwnerRecord
          })
        }
        setDNSOwnerToken(managedOwner)
        const guardianPid = guardianProcess?.pid
        if (
          guardianPid &&
          processIsAlive(guardianPid) &&
          isProcessCommandMatching(
            guardianPid,
            `--sparkle-dns-guardian=${guardianOwner.generation}`
          )
        ) {
          try {
            process.kill(guardianPid, 'SIGTERM')
          } catch {
            // The guardian may have exited after registration was inspected.
          }
          const deadline = Date.now() + 2000
          while (processIsAlive(guardianPid) && Date.now() < deadline) await delay(50)
          if (processIsAlive(guardianPid)) {
            throw new Error('Unable to stop the standby DNS guardian during rollback')
          }
        }
      },
      rollbackManagedCore: async () => {
        setDNSOwnerToken(managedOwner)
        if (directCoreState.child && directCoreState.detached) {
          throw new Error('Detached replacement is still running; managed core rollback is unsafe')
        }
        if (directCoreState.child) {
          const outcome = await reconcileSystemDNS(managedOwner)
          if (outcome.kind === 'not-ready' || outcome.kind === 'stale') {
            throw new Error('Managed core survived handoff but DNS could not be reconciled')
          }
          startDNSReconciliationMonitor()
        } else {
          if (!managedRollbackPrepared) throw new Error('Managed core rollback was not prepared')
          const promises = await startPreparedCore(managedRollbackPrepared)
          await Promise.all(promises)
        }
        if ((await getAppConfig()).networkDetection) await startNetworkDetection()
      },
      clearHandoffArtifacts: async () => {
        await removeCorePid(detachedCorePid)
        const current = await store.read()
        if (current?.detached?.generation === guardianOwner.generation) {
          await store.write({
            version: 1,
            owner: managedOwnerRecord
          })
        }
      },
      commitHandoff: async () => {
        const guardianPid = guardianProcess?.pid
        const guardianStartedAt = guardianPid ? readProcessIdentity(guardianPid) : undefined
        const record = await store.read()
        if (
          !detachedCorePid ||
          !directCoreState.detached ||
          directCoreState.child?.pid !== detachedCorePid ||
          !processIsAlive(detachedCorePid) ||
          !guardianPid ||
          !guardianStartedAt ||
          !processIsAlive(guardianPid) ||
          !isProcessCommandMatching(
            guardianPid,
            `--sparkle-dns-guardian=${guardianOwner.generation}`
          ) ||
          !record ||
          !sameDNSOwner(record.owner, managedOwner) ||
          record.detached?.generation !== guardianOwner.generation ||
          !record.detached.ready ||
          !record.detached.coreStartedAt ||
          readProcessIdentity(detachedCorePid) !== record.detached.coreStartedAt
        ) {
          throw new Error('Detached core or DNS guardian exited before ownership commit')
        }
        await drainDNSLifecycle()
        stopDNSReconciliationMonitor()
        await writeCorePid(detachedCorePid)
        const dnsSnapshot = await getDNSOwnershipSnapshot()
        await store.write({
          ...record,
          owner: { ...guardianOwner, pid: guardianPid, startedAt: guardianStartedAt },
          detached: {
            ...record.detached,
            ...dnsSnapshot,
            status: 'active',
            ready: true,
            request: undefined
          }
        })
        setDNSOwnerToken(undefined)
      },
      onCleanupError: (error) => {
        appendAppLog(`[Manager]: detached core handoff cleanup failed, ${error}\n`).catch(() => {})
      }
    })
  } finally {
    detachedHandoffInProgress = false
  }
}

export async function quitWithoutCore(): Promise<void> {
  try {
    await keepCoreAlive()
  } catch (error) {
    void showNotification({ title: '内核启动出错', body: `${error}`, variant: 'danger' })
    return
  }
  app.exit()
}

export async function startNetworkDetection(): Promise<void> {
  await startNetworkDetectionController({
    shouldStartCore: (networkDownHandled) => networkDownHandled && !directCoreState.child,
    startCore: async () => {
      const promises = await startCore()
      await Promise.all(promises)
    },
    stopCore,
    reconcileDNS: reconcileSystemDNS
  })
}

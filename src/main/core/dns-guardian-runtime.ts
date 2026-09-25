import { app, powerMonitor } from 'electron'
import { getAppConfig } from '../config'
import { initKeyManager } from '../service/manager'
import { dataDir } from '../utils/dirs'
import { appendAppLog } from '../utils/log'
import { registerDNSResumeReconciliation } from './dns-monitor'
import { createDNSGuardian } from './dns-guardian'
import { sameDNSOwner, type DNSOwnerToken } from './dns-owner'
import { dnsOwnerStore } from './dns-owner-store'
import {
  getServiceDNSForOwner,
  reconcileSystemDNS,
  recoverDNS,
  setDNSOwnerToken,
  startDNSGuardianMonitor,
  stopDNSReconciliationMonitor
} from './network'
import { normalizeDNS } from './dns-lifecycle'
import { rm, readFile } from 'fs/promises'
import path from 'path'
import {
  isProcessCommandMatching,
  processIsAlive,
  readProcessIdentity,
  systemOwnedProcessControl
} from './process-control'

async function isCoreAlive(
  pid: number,
  startedAt?: string,
  corePath?: string
): Promise<boolean> {
  if (!processIsAlive(pid)) return false
  if (startedAt) return readProcessIdentity(pid) === startedAt
  return !!corePath && isProcessCommandMatching(pid, corePath)
}

async function stopOwnedCore(pid: number, startedAt?: string): Promise<void> {
  if (!startedAt) throw new Error('Detached core identity is missing; refusing unsafe termination')
  await systemOwnedProcessControl().stop(pid, startedAt)
}

async function removeOwnedCorePid(pid: number): Promise<void> {
  const pidPath = path.join(dataDir(), 'core.pid')
  try {
    if (Number.parseInt((await readFile(pidPath, 'utf8')).trim(), 10) === pid) {
      await rm(pidPath)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

export async function runDNSGuardianProcess(generation: string): Promise<void> {
  const token: DNSOwnerToken = { kind: 'detached-guardian', generation }
  const store = dnsOwnerStore()
  await getAppConfig(true)
  await initKeyManager()

  let monitorActive = false
  const guardian = createDNSGuardian({
    token,
    readOwner: () => store.read(),
    writeOwner: (record) => store.write(record),
    clearOwner: (ownerGeneration) => store.clear(ownerGeneration),
    isProcessAlive: async (pid) => processIsAlive(pid),
    isOwnerProcessAlive: async (owner) =>
      !!owner.startedAt &&
      processIsAlive(owner.pid) &&
      readProcessIdentity(owner.pid) === owner.startedAt,
    isCoreAlive,
    isDNSApplied: async (record) => {
      const { targetService, appliedDNS } = record.detached || {}
      if (!targetService || !appliedDNS) {
        const config = await getAppConfig(true)
        if (!config.targetService || !config.appliedDNS) return true
        return (
          normalizeDNS(await getServiceDNSForOwner(config.targetService)) ===
          normalizeDNS(config.appliedDNS)
        )
      }
      return normalizeDNS(await getServiceDNSForOwner(targetService)) === normalizeDNS(appliedDNS)
    },
    stopCore: stopOwnedCore,
    getProcessIdentity: readProcessIdentity,
    reconcileDNS: reconcileSystemDNS,
    recoverDNS,
    startMonitor: (owner) => {
      monitorActive = true
      setDNSOwnerToken(owner)
      registerDNSResumeReconciliation(
        powerMonitor,
        () => monitorActive,
        () => {
          void reconcileSystemDNS(owner)
        }
      )
      startDNSGuardianMonitor(owner)
    },
    stopMonitor: () => {
      monitorActive = false
      stopDNSReconciliationMonitor()
      setDNSOwnerToken(undefined)
    },
    removeCorePid: removeOwnedCorePid,
    onExit: () => app.quit(),
    onError: (error) => {
      appendAppLog(`[DNS Guardian]: ${error}\n`).catch(() => {})
    }
  })

  app.dock?.hide()
  const handleTermination = (): void => {
    void guardian.terminate()
  }
  process.on('SIGTERM', handleTermination)
  process.on('SIGINT', handleTermination)
  await guardian.start()

  const deadline = Date.now() + 10000
  while (Date.now() < deadline) {
    const record = await store.read()
    if (record?.detached?.generation !== generation) {
      throw new Error('DNS guardian registration was removed during startup')
    }
    if (record.detached.guardianPid !== 0 && record.detached.guardianPid !== process.pid) {
      throw new Error('DNS guardian registration PID does not match this process')
    }
    if (record.detached.ready && record.detached.guardianPid === process.pid) break
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
  }
  const record = await store.read()
  if (
    !record ||
    record.detached?.generation !== generation ||
    !record.detached.ready ||
    record.detached.guardianPid !== process.pid
  ) {
    throw new Error('DNS guardian registration did not become durable')
  }
  if (sameDNSOwner(record.owner, token) && !record.detached) {
    throw new Error('DNS guardian owner state is incomplete')
  }
}

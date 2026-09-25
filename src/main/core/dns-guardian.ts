import { sameDNSOwner, type DNSOwnerRecord, type DNSOwnerToken } from './dns-owner'

export interface DNSGuardianDependencies {
  token: DNSOwnerToken
  readOwner: () => Promise<DNSOwnerRecord | undefined>
  writeOwner: (record: DNSOwnerRecord) => Promise<void>
  clearOwner: (generation: string) => Promise<boolean>
  isProcessAlive: (pid: number) => Promise<boolean>
  isOwnerProcessAlive?: (owner: DNSOwnerRecord['owner']) => Promise<boolean>
  isCoreAlive: (pid: number, startedAt?: string, corePath?: string) => Promise<boolean>
  isDNSApplied: (record: DNSOwnerRecord) => Promise<boolean>
  stopCore: (pid: number, startedAt?: string) => Promise<void>
  reconcileDNS: (token: DNSOwnerToken) => Promise<unknown>
  recoverDNS: (token: DNSOwnerToken) => Promise<void>
  startMonitor: (token: DNSOwnerToken) => void
  stopMonitor: () => void
  getProcessIdentity?: (pid: number) => string | undefined
  removeCorePid?: (pid: number) => Promise<void>
  onReady?: () => void
  onExit?: () => void
  onError?: (error: unknown) => void
  pollIntervalMs?: number
  setInterval?: typeof setInterval
  clearInterval?: typeof clearInterval
}

export interface DNSGuardian {
  start: () => Promise<void>
  poll: () => Promise<void>
  terminate: () => Promise<boolean>
  stop: () => void
}

export function createDNSGuardian(dependencies: DNSGuardianDependencies): DNSGuardian {
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let polling = false
  let terminating = false
  let monitorStarted = false
  let exited = false

  const reportError = (error: unknown): void => {
    dependencies.onError?.(error)
  }

  const ownerProcessAlive = (owner: DNSOwnerRecord['owner']): Promise<boolean> =>
    dependencies.isOwnerProcessAlive
      ? dependencies.isOwnerProcessAlive(owner)
      : dependencies.isProcessAlive(owner.pid)

  const currentGuardianOwner = (): DNSOwnerRecord['owner'] => ({
    ...dependencies.token,
    pid: process.pid,
    ...(dependencies.getProcessIdentity
      ? { startedAt: dependencies.getProcessIdentity(process.pid) }
      : {})
  })

  const inspectCore = async (
    record: DNSOwnerRecord
  ): Promise<{ alive: boolean; record: DNSOwnerRecord } | undefined> => {
    const detached = record.detached
    if (!detached?.corePid) return { alive: false, record }
    if (
      !(await dependencies.isCoreAlive(
        detached.corePid,
        detached.coreStartedAt,
        detached.corePath
      ))
    ) {
      return { alive: false, record }
    }
    if (detached.coreStartedAt) return { alive: true, record }

    const startedAt = dependencies.getProcessIdentity?.(detached.corePid)
    if (!startedAt) return undefined
    const current = await dependencies.readOwner()
    if (
      !current ||
      !sameDNSOwner(current.owner, record.owner) ||
      current.detached?.generation !== detached.generation
    ) {
      return undefined
    }
    const identified: DNSOwnerRecord = {
      ...current,
      detached: { ...current.detached, coreStartedAt: startedAt }
    }
    await dependencies.writeOwner(identified)
    return { alive: true, record: identified }
  }

  const finish = (): void => {
    if (exited) return
    exited = true
    if (pollTimer) {
      ;(dependencies.clearInterval || clearInterval)(pollTimer)
      pollTimer = undefined
    }
    if (monitorStarted) {
      dependencies.stopMonitor()
      monitorStarted = false
    }
    dependencies.onExit?.()
  }

  const release = async (record: DNSOwnerRecord, stopCore: boolean): Promise<void> => {
    if (!sameDNSOwner(record.owner, dependencies.token)) return finish()
    if (monitorStarted) {
      dependencies.stopMonitor()
      monitorStarted = false
    }
    const detached = record.detached
    if (stopCore && detached?.corePid) {
      const inspected = await inspectCore(record)
      if (!inspected) {
        throw new Error('Unable to verify detached core identity during guardian shutdown')
      }
      if (inspected.alive) {
        const identified = inspected.record.detached
        await dependencies.stopCore(detached.corePid, identified?.coreStartedAt)
      }
    }
    await dependencies.recoverDNS(dependencies.token)
    if (detached?.corePid) await dependencies.removeCorePid?.(detached.corePid)
    await dependencies.clearOwner(dependencies.token.generation)
    finish()
  }

  const promoteOrRecover = async (record: DNSOwnerRecord): Promise<void> => {
    let detached = record.detached
    if (!detached || detached.generation !== dependencies.token.generation) return finish()

    const inspected = await inspectCore(record)
    if (!inspected) return
    record = inspected.record
    detached = record.detached!
    const coreAlive = inspected.alive
    if (coreAlive && (await dependencies.isDNSApplied(record))) {
      const activeRecord: DNSOwnerRecord = {
        ...record,
        owner: currentGuardianOwner(),
        detached: { ...detached, status: 'active', ready: true, request: undefined }
      }
      await dependencies.writeOwner(activeRecord)
      await beginMonitoring(activeRecord)
      return
    }

    const recoveryRecord: DNSOwnerRecord = {
      ...record,
      owner: currentGuardianOwner(),
      detached: { ...detached, status: 'active', ready: true, request: undefined }
    }
    await dependencies.writeOwner(recoveryRecord)
    if (coreAlive && detached.corePid) {
      await dependencies.stopCore(detached.corePid, detached.coreStartedAt)
    }
    await release(recoveryRecord, false)
  }

  const beginMonitoring = async (record: DNSOwnerRecord): Promise<void> => {
    const detached = record.detached
    if (!detached || !sameDNSOwner(record.owner, dependencies.token)) return finish()
    if (detached.guardianPid !== process.pid || record.owner.pid !== process.pid) {
      record = {
        ...record,
        owner: currentGuardianOwner(),
        detached: { ...detached, guardianPid: process.pid }
      }
      await dependencies.writeOwner(record)
    }
    const inspected = await inspectCore(record)
    if (!inspected) return
    record = inspected.record
    if (!inspected.alive) {
      await release(record, false)
      return
    }
    if (!(await dependencies.isDNSApplied(record))) {
      await release(record, false)
      return
    }
    if (!monitorStarted) {
      monitorStarted = true
      dependencies.startMonitor(dependencies.token)
    }
  }

  const poll = async (): Promise<void> => {
    if (polling || exited) return
    polling = true
    try {
      const record = await dependencies.readOwner()
      if (!record?.detached || record.detached.generation !== dependencies.token.generation) {
        finish()
        return
      }

      if (record.detached.request?.type === 'relaunch') {
        if (sameDNSOwner(record.owner, dependencies.token)) {
          await release(record, true)
          return
        }
        if (record.owner.kind === 'managed-app' && !(await ownerProcessAlive(record.owner))) {
          const transferred: DNSOwnerRecord = {
            ...record,
            owner: currentGuardianOwner(),
            detached: { ...record.detached, status: 'active', ready: true, request: undefined }
          }
          await dependencies.writeOwner(transferred)
          await release(transferred, true)
        }
        return
      }

      if (sameDNSOwner(record.owner, dependencies.token)) {
        await beginMonitoring(record)
        return
      }

      if (record.owner.kind !== 'managed-app') {
        finish()
        return
      }

      const ownerAlive = await ownerProcessAlive(record.owner)
      if (!ownerAlive) {
        await promoteOrRecover(record)
        return
      }

      if (!record.detached.ready) {
        await dependencies.writeOwner({
          ...record,
          detached: { ...record.detached, ready: true }
        })
        dependencies.onReady?.()
      }
    } catch (error) {
      reportError(error)
    } finally {
      polling = false
    }
  }

  return {
    async start() {
      await poll()
      if (!exited && !pollTimer) {
        pollTimer = (dependencies.setInterval || setInterval)(
          () => void poll(),
          dependencies.pollIntervalMs ?? 1000
        )
      }
    },
    poll,
    async terminate() {
      if (terminating || exited) return false
      terminating = true
      try {
        const record = await dependencies.readOwner()
        if (!record || !sameDNSOwner(record.owner, dependencies.token)) {
          finish()
          return true
        }
        await release(record, true)
        return true
      } catch (error) {
        reportError(error)
        return false
      } finally {
        terminating = false
      }
    },
    stop() {
      finish()
    }
  }
}

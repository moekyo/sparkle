import { isIP } from 'node:net'
import type { DNSOwnerToken } from './dns-owner'

export type DNSSettingMode = 'none' | 'exec' | 'service'
export type DNSWriteMode = Exclude<DNSSettingMode, 'none'>
export type DNSOwnershipPhase = 'applying' | 'applied' | 'restoring'

export interface DNSLifecycleState {
  originDNS?: string
  appliedDNS?: string
  targetService?: string
  appliedDNSMode?: DNSWriteMode
  phase?: DNSOwnershipPhase
}

interface DNSLifecycleDependencies {
  readState: () => Promise<DNSLifecycleState>
  writeState: (state: DNSLifecycleState) => Promise<void>
  getDefaultService: () => Promise<string>
  readDNS: (service: string) => Promise<string>
  writeDNS: (service: string, dns: string, mode: DNSWriteMode) => Promise<void>
  isOwnerCurrent?: (owner: DNSOwnerToken) => Promise<boolean>
}

interface RuntimeDNSConfig {
  enable?: boolean
  listen?: string
}

interface RuntimeTUNConfig {
  enable?: boolean
  'dns-hijack'?: string[]
}

interface RuntimeConfig {
  dns?: RuntimeDNSConfig
  tun?: RuntimeTUNConfig
}

interface RuntimeTUNStatus {
  enable?: boolean
  'inet4-address'?: string[]
  'inet6-address'?: string[]
}

export function normalizeDNS(value: string): string {
  const trimmed = value.trim()
  if (
    !trimmed ||
    trimmed === 'Empty' ||
    trimmed.startsWith("There aren't any DNS Servers set on")
  ) {
    return 'Empty'
  }
  return trimmed.split(/\s+/).join(' ')
}

function dnsValuesEqual(left: string, right: string): boolean {
  const leftValues = normalizeDNS(left).toLowerCase().split(' ')
  const rightValues = normalizeDNS(right).toLowerCase().split(' ')
  return (
    leftValues.length === rightValues.length &&
    leftValues.every((value, index) => value === rightValues[index])
  )
}

function parseHostPort(value: string): { host: string; port: number } | undefined {
  const address = value.trim().replace(/^(?:udp|tcp):\/\//i, '')
  let host: string
  let portValue: string

  if (address.startsWith('[')) {
    const closingBracket = address.indexOf(']')
    if (closingBracket < 0 || address[closingBracket + 1] !== ':') return undefined
    host = address.slice(1, closingBracket)
    portValue = address.slice(closingBracket + 2)
  } else {
    const separator = address.lastIndexOf(':')
    if (separator < 0) return undefined
    host = address.slice(0, separator)
    portValue = address.slice(separator + 1)
  }

  if (!/^\d+$/.test(portValue)) return undefined
  const port = Number(portValue)
  if (port < 1 || port > 65535) return undefined
  return { host, port }
}

function normalizeResolverHost(host: string): string | undefined {
  if (host === '' || host === '*' || host === 'any' || host === '0.0.0.0') return '127.0.0.1'
  if (host === '::') return '::1'
  if (host.toLowerCase() === 'localhost') return '127.0.0.1'
  return isIP(host) ? host : undefined
}

function getTunResolverAddress(tun: RuntimeTUNStatus): string | undefined {
  for (const address of tun['inet4-address'] || []) {
    const host = address.split('/')[0]
    if (isIP(host) === 4) return host
  }
  for (const address of tun['inet6-address'] || []) {
    const host = address.split('/')[0]
    if (isIP(host) === 6) return host
  }
  return undefined
}

function getHijackedResolverAddress(hijack: string[]): string | undefined {
  for (const entry of hijack) {
    const listener = parseHostPort(entry)
    if (!listener || listener.port !== 53) continue
    const host = listener.host.toLowerCase()
    if (host === '' || host === '*' || host === 'any' || host === '0.0.0.0' || host === '::') {
      return undefined
    }
    const address = normalizeResolverHost(listener.host)
    if (address) return address
  }
  return undefined
}

export function resolveSystemDnsTarget(
  runtimeConfig: RuntimeConfig,
  tunStatus?: RuntimeTUNStatus
): string | undefined {
  if (runtimeConfig.dns?.enable === false) return undefined

  const listener = runtimeConfig.dns?.listen ? parseHostPort(runtimeConfig.dns.listen) : undefined
  if (listener?.port === 53) {
    const address = normalizeResolverHost(listener.host)
    if (address) return address
  }

  if (!runtimeConfig.tun?.enable || !tunStatus?.enable) return undefined
  const hijack = runtimeConfig.tun['dns-hijack'] || []
  if (!hijack.some((entry) => parseHostPort(entry)?.port === 53)) return undefined

  return getHijackedResolverAddress(hijack) || getTunResolverAddress(tunStatus)
}

export function createDNSLifecycle(dependencies: DNSLifecycleDependencies): {
  apply: (target: string, mode: DNSSettingMode, owner?: DNSOwnerToken) => Promise<boolean>
  recover: (mode?: DNSSettingMode, owner?: DNSOwnerToken) => Promise<boolean>
  drain: () => Promise<void>
} {
  let operationQueue = Promise.resolve()

  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = operationQueue.then(operation, operation)
    operationQueue = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  const hasState = (state: DNSLifecycleState): boolean =>
    state.originDNS !== undefined ||
    state.appliedDNS !== undefined ||
    state.targetService !== undefined ||
    state.phase !== undefined

  const clearState = (): Promise<void> => dependencies.writeState({})

  const isOwnerCurrent = async (owner?: DNSOwnerToken): Promise<boolean> =>
    !owner || !dependencies.isOwnerCurrent || dependencies.isOwnerCurrent(owner)

  const writeDNSAndVerify = async (
    service: string,
    dns: string,
    modes: Iterable<DNSWriteMode>,
    owner?: DNSOwnerToken
  ): Promise<DNSWriteMode | undefined> => {
    let lastError: unknown
    for (const writeMode of modes) {
      if (!(await isOwnerCurrent(owner))) return undefined
      let writeError: unknown
      try {
        await dependencies.writeDNS(service, dns, writeMode)
      } catch (error) {
        writeError = error
      }

      try {
        if (dnsValuesEqual(await dependencies.readDNS(service), dns)) return writeMode
        lastError = writeError ?? new Error(`DNS write verification failed for service ${service}`)
      } catch (error) {
        lastError = writeError ?? error
      }
    }
    throw lastError ?? new Error(`DNS write verification failed for service ${service}`)
  }

  const restoreState = async (
    state: DNSLifecycleState,
    mode: DNSSettingMode,
    owner?: DNSOwnerToken
  ): Promise<'restored' | 'origin' | 'external' | 'stale'> => {
    if (!(await isOwnerCurrent(owner))) return 'stale'
    if (!hasState(state)) return 'origin'
    if (
      state.originDNS === undefined ||
      state.targetService === undefined ||
      state.appliedDNS === undefined
    ) {
      if (!(await isOwnerCurrent(owner))) return 'stale'
      await clearState()
      return 'external'
    }

    const originDNS = state.originDNS
    const appliedDNS = state.appliedDNS
    const service = state.targetService
    let currentDNS = normalizeDNS(await dependencies.readDNS(service))
    if (state.phase === 'applying') {
      if (!dnsValuesEqual(currentDNS, appliedDNS)) {
        if (!(await isOwnerCurrent(owner))) return 'stale'
        await clearState()
        return dnsValuesEqual(currentDNS, originDNS) ? 'origin' : 'external'
      }
      state = { ...state, phase: 'applied' }
      if (!(await isOwnerCurrent(owner))) return 'stale'
      await dependencies.writeState(state)
    } else if (state.phase === 'restoring') {
      if (dnsValuesEqual(currentDNS, originDNS)) {
        if (!(await isOwnerCurrent(owner))) return 'stale'
        await clearState()
        return 'origin'
      }
      if (!dnsValuesEqual(currentDNS, appliedDNS)) {
        if (!(await isOwnerCurrent(owner))) return 'stale'
        await clearState()
        return 'external'
      }
      state = { ...state, phase: 'applied' }
      if (!(await isOwnerCurrent(owner))) return 'stale'
      await dependencies.writeState(state)
    }

    if (dnsValuesEqual(currentDNS, originDNS)) {
      if (!(await isOwnerCurrent(owner))) return 'stale'
      await clearState()
      return 'origin'
    }
    if (!dnsValuesEqual(currentDNS, appliedDNS)) {
      if (!(await isOwnerCurrent(owner))) return 'stale'
      await clearState()
      return 'external'
    }

    const restoringState = { ...state, phase: 'restoring' as const }
    if (!(await isOwnerCurrent(owner))) return 'stale'
    await dependencies.writeState(restoringState)
    const restoreModes = new Set<DNSWriteMode>([
      state.appliedDNSMode || (mode === 'service' ? 'service' : 'exec'),
      mode === 'service' ? 'service' : 'exec',
      'exec'
    ])
    const restoredMode = await writeDNSAndVerify(service, originDNS, restoreModes, owner)
    if (restoredMode === undefined) return 'stale'
    currentDNS = normalizeDNS(await dependencies.readDNS(service))
    if (!dnsValuesEqual(currentDNS, originDNS)) {
      throw new Error(`DNS restore verification failed for service ${service}`)
    }
    if (!(await isOwnerCurrent(owner))) return 'stale'
    await clearState()
    return 'restored'
  }

  const recover = (mode: DNSSettingMode = 'none', owner?: DNSOwnerToken): Promise<boolean> =>
    serialize(async () => {
      if (!(await isOwnerCurrent(owner))) return false
      return (await restoreState(await dependencies.readState(), mode, owner)) !== 'stale'
    })

  const apply = (target: string, mode: DNSSettingMode, owner?: DNSOwnerToken): Promise<boolean> =>
    serialize(async () => {
      if (!(await isOwnerCurrent(owner))) return false
      if (mode === 'none' || !target.trim()) return true

      let state = await dependencies.readState()
      if (
        hasState(state) &&
        (state.phase === 'applying' ||
          state.phase === 'restoring' ||
          state.originDNS === undefined ||
          state.appliedDNS === undefined ||
          state.targetService === undefined)
      ) {
        const oldService = state.targetService
        const recoveryResult = await restoreState(state, mode, owner)
        if (recoveryResult === 'stale') return false
        if (recoveryResult === 'external' && !oldService) return true
        if (recoveryResult === 'external') {
          const currentService = await dependencies.getDefaultService()
          if (currentService === oldService) return true
        }
        state = {}
      }

      let service = await dependencies.getDefaultService()
      if (state.targetService && state.targetService !== service) {
        const recoveryResult = await restoreState(state, mode, owner)
        if (recoveryResult === 'stale') return false
        state = {}
        service = await dependencies.getDefaultService()
      }

      const currentDNS = normalizeDNS(await dependencies.readDNS(service))
      if (!(await isOwnerCurrent(owner))) return false
      const hasCommittedOwnership = state.phase === 'applied' || state.phase === undefined
      const committedStateForService =
        hasCommittedOwnership &&
        state.targetService === service &&
        state.originDNS !== undefined &&
        state.appliedDNS !== undefined
      if (
        committedStateForService &&
        !dnsValuesEqual(currentDNS, state.appliedDNS!) &&
        !dnsValuesEqual(currentDNS, state.originDNS!)
      ) {
        await clearState()
        return true
      }
      const previousStateIsApplied =
        hasCommittedOwnership &&
        state.targetService === service &&
        state.originDNS !== undefined &&
        state.appliedDNS !== undefined &&
        dnsValuesEqual(currentDNS, state.appliedDNS)
      const originDNS = previousStateIsApplied ? state.originDNS! : currentDNS
      const normalizedTarget = normalizeDNS(target)
      const alreadyApplied = previousStateIsApplied && dnsValuesEqual(currentDNS, normalizedTarget)

      const applyingState: DNSLifecycleState = {
        originDNS,
        appliedDNS: normalizedTarget,
        targetService: service,
        appliedDNSMode: alreadyApplied ? state.appliedDNSMode || mode : mode,
        phase: 'applying'
      }
      if (!(await isOwnerCurrent(owner))) return false
      await dependencies.writeState(applyingState)

      let appliedMode = applyingState.appliedDNSMode!
      if (!alreadyApplied) {
        try {
          const writeMode = await writeDNSAndVerify(
            service,
            normalizedTarget,
            mode === 'service' ? ['service', 'exec'] : [mode],
            owner
          )
          if (writeMode === undefined) return false
          appliedMode = writeMode
        } catch (error) {
          const afterFailure = normalizeDNS(await dependencies.readDNS(service))
          if (dnsValuesEqual(afterFailure, normalizedTarget)) {
            if (!(await isOwnerCurrent(owner))) return false
            await dependencies.writeState({
              ...applyingState,
              appliedDNSMode: mode,
              phase: 'applied'
            })
            return true
          }
          if (!(await isOwnerCurrent(owner))) return false
          await clearState()
          throw error
        }
      }

      if (!(await isOwnerCurrent(owner))) return false
      await dependencies.writeState({
        ...applyingState,
        appliedDNSMode: appliedMode,
        phase: 'applied'
      })
      return true
    })

  return { apply, recover, drain: () => operationQueue }
}

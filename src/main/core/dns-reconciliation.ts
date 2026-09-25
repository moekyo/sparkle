import type { DNSSettingMode } from './dns-lifecycle'
import type { DNSOwnerToken } from './dns-owner'

export interface DNSReconcileRuntimeConfig {
  dns?: { enable?: boolean }
  tun?: { enable?: boolean }
}

export interface DNSReconcileControllerConfig {
  tun?: { enable?: boolean }
}

export type DNSReconcileOutcome =
  | { kind: 'applied'; target: string }
  | { kind: 'recovered' }
  | { kind: 'not-ready' }
  | { kind: 'stale' }

export interface DNSReconcilerDependencies {
  getMode: () => Promise<DNSSettingMode>
  isOnline: () => boolean
  getRuntimeConfig: () => Promise<DNSReconcileRuntimeConfig | undefined>
  getControllerConfig: () => Promise<DNSReconcileControllerConfig | undefined>
  resolveTarget: (
    runtimeConfig: DNSReconcileRuntimeConfig,
    controllerConfig: DNSReconcileControllerConfig
  ) => string | undefined
  waitForResolver: (target: string, signal: AbortSignal) => Promise<boolean>
  apply: (target: string, mode: DNSSettingMode, owner?: DNSOwnerToken) => Promise<void | boolean>
  recover: (mode: DNSSettingMode, owner?: DNSOwnerToken) => Promise<void | boolean>
  isOwnerCurrent?: (owner: DNSOwnerToken) => Promise<boolean>
  isServiceOwnerKnown?: () => Promise<boolean>
}

export function createDNSReconciler(dependencies: DNSReconcilerDependencies): {
  reconcile: (owner?: DNSOwnerToken) => Promise<DNSReconcileOutcome>
  invalidate: () => void
  recover: (mode?: DNSSettingMode, owner?: DNSOwnerToken) => Promise<boolean>
} {
  let generation = 0
  let activeProbe: AbortController | undefined

  const invalidate = (): void => {
    generation++
    activeProbe?.abort()
    activeProbe = undefined
  }

  const reconcile = async (owner?: DNSOwnerToken): Promise<DNSReconcileOutcome> => {
    activeProbe?.abort()
    const currentGeneration = ++generation
    const probeController = new AbortController()
    activeProbe = probeController
    const isCurrent = (): boolean => currentGeneration === generation
    const isAuthorized = async (): Promise<boolean> =>
      isCurrent() && (!owner || !dependencies.isOwnerCurrent || dependencies.isOwnerCurrent(owner))
    const stale = (): DNSReconcileOutcome => ({ kind: 'stale' })

    try {
      const mode = await dependencies.getMode()
      if (!(await isAuthorized())) return stale()
      if (mode === 'none' || !dependencies.isOnline()) {
        const recovered = await dependencies.recover(mode, owner)
        return (await isAuthorized()) && recovered !== false ? { kind: 'recovered' } : stale()
      }

      const runtimeConfig = await dependencies.getRuntimeConfig()
      if (!(await isAuthorized())) return stale()
      if (!runtimeConfig) return { kind: 'not-ready' }
      if (runtimeConfig.tun?.enable !== true || runtimeConfig.dns?.enable === false) {
        const recovered = await dependencies.recover(mode, owner)
        return (await isAuthorized()) && recovered !== false ? { kind: 'recovered' } : stale()
      }

      const controllerConfig = await dependencies.getControllerConfig()
      if (!(await isAuthorized())) return stale()
      if (!controllerConfig) {
        return { kind: 'not-ready' }
      }

      if (dependencies.isServiceOwnerKnown && !(await dependencies.isServiceOwnerKnown())) {
        if (!(await isAuthorized())) return stale()
        const recovered = await dependencies.recover(mode, owner)
        return (await isAuthorized()) && recovered !== false ? { kind: 'recovered' } : stale()
      }

      if (controllerConfig.tun?.enable !== true) {
        const recovered = await dependencies.recover(mode, owner)
        return (await isAuthorized()) && recovered !== false ? { kind: 'recovered' } : stale()
      }

      const target = dependencies.resolveTarget(runtimeConfig, controllerConfig)
      if (!(await isAuthorized())) return stale()
      if (!target) {
        const recovered = await dependencies.recover(mode, owner)
        return (await isAuthorized()) && recovered !== false ? { kind: 'not-ready' } : stale()
      }

      const resolverAvailable = await dependencies.waitForResolver(target, probeController.signal)
      if (!(await isAuthorized())) return stale()
      if (!resolverAvailable) return { kind: 'not-ready' }

      if (!(await isAuthorized())) return stale()
      const applied = await dependencies.apply(target, mode, owner)
      return (await isAuthorized()) && applied !== false ? { kind: 'applied', target } : stale()
    } catch (error) {
      if (!(await isAuthorized())) return stale()
      throw error
    } finally {
      if (isCurrent() && activeProbe === probeController) activeProbe = undefined
    }
  }

  const recover = async (
    mode: DNSSettingMode = 'none',
    owner?: DNSOwnerToken
  ): Promise<boolean> => {
    invalidate()
    if (owner && dependencies.isOwnerCurrent && !(await dependencies.isOwnerCurrent(owner))) {
      return false
    }
    return (await dependencies.recover(mode, owner)) !== false
  }

  return { reconcile, invalidate, recover }
}

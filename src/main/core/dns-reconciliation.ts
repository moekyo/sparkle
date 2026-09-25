import type { DNSSettingMode } from './dns-lifecycle'

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
  apply: (target: string, mode: DNSSettingMode) => Promise<void>
  recover: (mode: DNSSettingMode) => Promise<void>
}

export function createDNSReconciler(dependencies: DNSReconcilerDependencies): {
  reconcile: () => Promise<DNSReconcileOutcome>
  invalidate: () => void
  recover: (mode?: DNSSettingMode) => Promise<void>
} {
  let generation = 0
  let activeProbe: AbortController | undefined

  const invalidate = (): void => {
    generation++
    activeProbe?.abort()
    activeProbe = undefined
  }

  const reconcile = async (): Promise<DNSReconcileOutcome> => {
    activeProbe?.abort()
    const currentGeneration = ++generation
    const probeController = new AbortController()
    activeProbe = probeController
    const isCurrent = (): boolean => currentGeneration === generation
    const stale = (): DNSReconcileOutcome => ({ kind: 'stale' })

    try {
      const mode = await dependencies.getMode()
      if (!isCurrent()) return stale()
      if (mode === 'none' || !dependencies.isOnline()) {
        await dependencies.recover(mode)
        return isCurrent() ? { kind: 'recovered' } : stale()
      }

      const runtimeConfig = await dependencies.getRuntimeConfig()
      if (!isCurrent()) return stale()
      if (!runtimeConfig) return { kind: 'not-ready' }
      if (runtimeConfig.tun?.enable !== true || runtimeConfig.dns?.enable === false) {
        await dependencies.recover(mode)
        return isCurrent() ? { kind: 'recovered' } : stale()
      }

      const controllerConfig = await dependencies.getControllerConfig()
      if (!isCurrent()) return stale()
      if (!controllerConfig) {
        return { kind: 'not-ready' }
      }
      if (controllerConfig.tun?.enable !== true) {
        await dependencies.recover(mode)
        return isCurrent() ? { kind: 'recovered' } : stale()
      }

      const target = dependencies.resolveTarget(runtimeConfig, controllerConfig)
      if (!isCurrent()) return stale()
      if (!target) {
        await dependencies.recover(mode)
        return isCurrent() ? { kind: 'not-ready' } : stale()
      }

      const resolverAvailable = await dependencies.waitForResolver(target, probeController.signal)
      if (!isCurrent()) return stale()
      if (!resolverAvailable) return { kind: 'not-ready' }

      if (!isCurrent()) return stale()
      await dependencies.apply(target, mode)
      return isCurrent() ? { kind: 'applied', target } : stale()
    } catch (error) {
      if (!isCurrent()) return stale()
      throw error
    } finally {
      if (isCurrent() && activeProbe === probeController) activeProbe = undefined
    }
  }

  const recover = async (mode: DNSSettingMode = 'none'): Promise<void> => {
    invalidate()
    await dependencies.recover(mode)
  }

  return { reconcile, invalidate, recover }
}

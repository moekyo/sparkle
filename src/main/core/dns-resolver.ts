import { Resolver } from 'node:dns/promises'

export interface DNSResolverClient {
  setServers(servers: string[]): void
  resolve4(hostname: string): Promise<string[]>
  cancel(): void
}

export function createDNSResolverProbe(options: {
  createResolver?: () => DNSResolverClient
  timeoutMs?: number
} = {}): (address: string, signal: AbortSignal) => Promise<boolean> {
  const createResolver = options.createResolver ?? (() => new Resolver())
  const timeoutMs = options.timeoutMs ?? 1200

  return (address, signal) => {
    const resolver = createResolver()
    try {
      resolver.setServers([address])
    } catch {
      return Promise.resolve(false)
    }

    return new Promise((resolve) => {
      let settled = false
      const finish = (available: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        resolve(available)
      }
      const cancel = (): void => {
        try {
          resolver.cancel()
        } finally {
          finish(false)
        }
      }
      const abort = (): void => cancel()
      const timer = setTimeout(cancel, timeoutMs)

      if (signal.aborted) {
        cancel()
        return
      }
      signal.addEventListener('abort', abort, { once: true })

      resolver.resolve4('sparkle-dns-probe.invalid').then(
        () => finish(true),
        (error: NodeJS.ErrnoException) =>
          finish(error.code === 'ENOTFOUND' || error.code === 'ENODATA')
      )
    })
  }
}

import { createDNSOwnerToken, type DNSOwnerRecord } from './dns-owner'
import type { DNSOwnerStore } from './dns-owner-store'

export function createDNSOwnerCoordinator(dependencies: {
  store: DNSOwnerStore
  isProcessAlive: (pid: number) => Promise<boolean>
  isOwnerProcessAlive?: (owner: DNSOwnerRecord['owner']) => Promise<boolean>
  getProcessIdentity?: (pid: number) => Promise<string | undefined>
  isGuardianAlive: (record: DNSOwnerRecord) => Promise<boolean>
  requestGuardianRelease: (record: DNSOwnerRecord) => Promise<void>
  stopDetachedCore: (record: DNSOwnerRecord) => Promise<void>
  recoverDNS: (owner: DNSOwnerRecord['owner']) => Promise<void>
  createToken?: typeof createDNSOwnerToken
}) {
  const createToken = dependencies.createToken ?? createDNSOwnerToken

  return {
    async acquireManagedOwner(pid: number) {
      const isOwnerProcessAlive =
        dependencies.isOwnerProcessAlive ?? ((owner) => dependencies.isProcessAlive(owner.pid))
      for (let attempt = 0; attempt < 3; attempt++) {
        const record = await dependencies.store.read()
        if (!record) {
          const token = createToken('managed-app')
          const startedAt = await dependencies.getProcessIdentity?.(pid)
          if (dependencies.getProcessIdentity && !startedAt) {
            throw new Error('Unable to identify the managed DNS owner process')
          }
          await dependencies.store.write({
            version: 1,
            owner: { ...token, pid, ...(startedAt ? { startedAt } : {}) }
          })
          return token
        }

        const ownerAlive = await isOwnerProcessAlive(record.owner)
        if (record.owner.kind === 'managed-app' && record.owner.pid === pid && ownerAlive) {
          if (record.detached) {
            throw new Error('Detached DNS ownership handoff is already in progress')
          }
          return record.owner
        }

        if (record.owner.kind === 'detached-guardian') {
          if (await dependencies.isGuardianAlive(record)) {
            await dependencies.requestGuardianRelease(record)
            continue
          }
        } else if (ownerAlive) {
          throw new Error('Another Sparkle DNS owner is still active')
        } else if (record.detached && (await dependencies.isGuardianAlive(record))) {
          await dependencies.requestGuardianRelease(record)
          continue
        }

        if (record.detached) await dependencies.stopDetachedCore(record)
        await dependencies.recoverDNS(record.owner)
        const generation = record.detached?.generation || record.owner.generation
        if (!(await dependencies.store.clear(generation))) continue
      }

      throw new Error('Unable to acquire managed DNS ownership after guardian handback')
    }
  }
}

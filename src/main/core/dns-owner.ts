import { randomUUID } from 'crypto'
import type { DNSWriteMode } from './dns-lifecycle'

export type DNSOwnerKind = 'managed-app' | 'detached-guardian'

export interface DNSOwnerToken {
  kind: DNSOwnerKind
  generation: string
}

export interface DNSOwnerRecord {
  version: 1
  owner: DNSOwnerToken & { pid: number; startedAt?: string }
  detached?: {
    generation: string
    guardianPid: number
    status: 'preparing' | 'active'
    ready: boolean
    corePid?: number
    coreStartedAt?: string
    corePath?: string
    targetService?: string
    originDNS?: string
    appliedDNS?: string
    appliedDNSMode?: DNSWriteMode
    request?: { type: 'relaunch'; requestId: string; requestedBy: number }
  }
}

export function createDNSOwnerToken(kind: DNSOwnerKind): DNSOwnerToken {
  return { kind, generation: randomUUID() }
}

export function sameDNSOwner(
  left: DNSOwnerToken | undefined,
  right: DNSOwnerToken | undefined
): boolean {
  return !!left && !!right && left.kind === right.kind && left.generation === right.generation
}

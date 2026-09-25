import { randomUUID } from 'crypto'
import { open, mkdir, readFile, rename, unlink } from 'fs/promises'
import path from 'path'
import { dataDir } from '../utils/dirs'
import type { DNSOwnerRecord } from './dns-owner'

export interface DNSOwnerStore {
  read: () => Promise<DNSOwnerRecord | undefined>
  write: (record: DNSOwnerRecord) => Promise<void>
  clear: (generation: string) => Promise<boolean>
}

export function createDNSOwnerStore(filePath: string): DNSOwnerStore {
  const read = async (): Promise<DNSOwnerRecord | undefined> => {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf8')) as DNSOwnerRecord
      if (
        parsed.version !== 1 ||
        !parsed.owner ||
        !parsed.owner.generation ||
        !Number.isInteger(parsed.owner.pid)
      ) {
        throw new Error('Invalid DNS owner state')
      }
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  return {
    read,
    async write(record) {
      const directory = path.dirname(filePath)
      await mkdir(directory, { recursive: true })
      const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`
      const handle = await open(temporaryPath, 'wx', 0o600)
      try {
        await handle.writeFile(JSON.stringify(record), 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      await rename(temporaryPath, filePath)
      await syncDirectory(directory)
    },
    async clear(generation) {
      const current = await read()
      if (
        !current ||
        (current.owner.generation !== generation && current.detached?.generation !== generation)
      ) {
        return false
      }
      await unlink(filePath)
      await syncDirectory(path.dirname(filePath))
      return true
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  try {
    const handle = await open(directory, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
  } catch {
    // Some filesystems do not permit syncing directory handles; the state file itself is synced.
  }
}

export function dnsOwnerStore(): DNSOwnerStore {
  return createDNSOwnerStore(path.join(dataDir(), 'dns-owner.json'))
}

import { execFileSync, type ChildProcess } from 'child_process'
import { appendAppLog } from '../utils/log'
import { createOwnedProcessControl } from './owned-process-control'

function isProcessAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function stopChildProcess(process: ChildProcess): Promise<void> {
  return new Promise<void>((resolve) => {
    if (!process || process.exitCode !== null || process.signalCode !== null) {
      resolve()
      return
    }

    const pid = process.pid
    if (!pid) {
      resolve()
      return
    }

    process.removeAllListeners()

    let isResolved = false
    const timers: NodeJS.Timeout[] = []

    const resolveOnce = (): void => {
      if (!isResolved) {
        isResolved = true

        timers.forEach((timer) => clearTimeout(timer))
        resolve()
      }
    }

    process.once('close', resolveOnce)
    process.once('exit', resolveOnce)

    try {
      process.kill('SIGINT')
    } catch {
      // ignore
    }
    if (!isProcessAlive(pid)) {
      resolveOnce()
      return
    }

    const timer1 = setTimeout(() => {
      if (isResolved) return
      if (!isProcessAlive(pid)) {
        resolveOnce()
        return
      }
      try {
        process.kill('SIGTERM')
      } catch {
        // ignore
      }
    }, 3000)
    timers.push(timer1)

    const timer2 = setTimeout(() => {
      if (isResolved) return
      if (isProcessAlive(pid)) {
        try {
          process.kill('SIGKILL')
          appendAppLog(`[Manager]: Force killed process ${pid} with SIGKILL\n`).catch(() => {})
        } catch {
          // ignore
        }
      }
      resolveOnce()
    }, 6000)
    timers.push(timer2)
  })
}

export function processIsAlive(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function readProcessIdentity(pid: number): string | undefined {
  try {
    return (
      execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8' }).trim() ||
      undefined
    )
  } catch {
    return undefined
  }
}

export function isProcessCommandMatching(pid: number, fragment: string): boolean {
  try {
    const command = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
      encoding: 'utf8'
    })
    return command.includes(fragment)
  } catch {
    return false
  }
}

export function systemOwnedProcessControl() {
  return createOwnedProcessControl({
    isAlive: async (pid, identity) => processIsAlive(pid) && readProcessIdentity(pid) === identity,
    sendSignal: (pid, signal) => process.kill(pid, signal),
    delay: async (ms) => {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, ms)
      })
    }
  })
}

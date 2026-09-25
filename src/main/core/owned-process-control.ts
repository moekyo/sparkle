export interface OwnedProcessControlDependencies {
  isAlive: (pid: number, identity: string) => Promise<boolean>
  sendSignal: (pid: number, signal: NodeJS.Signals) => void
  delay: (ms: number) => Promise<void>
}

export function createOwnedProcessControl(dependencies: OwnedProcessControlDependencies) {
  const waitForExit = async (
    pid: number,
    identity: string,
    timeoutMs: number
  ): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (!(await dependencies.isAlive(pid, identity))) return true
      await dependencies.delay(100)
    }
    return !(await dependencies.isAlive(pid, identity))
  }

  return {
    isAlive: dependencies.isAlive,
    async stop(pid: number, identity: string): Promise<void> {
      if (!(await dependencies.isAlive(pid, identity))) return
      dependencies.sendSignal(pid, 'SIGINT')
      if (await waitForExit(pid, identity, 2500)) return
      if (await dependencies.isAlive(pid, identity)) dependencies.sendSignal(pid, 'SIGTERM')
      if (await waitForExit(pid, identity, 1500)) return
      if (await dependencies.isAlive(pid, identity)) dependencies.sendSignal(pid, 'SIGKILL')
      if (!(await waitForExit(pid, identity, 1500))) {
        throw new Error(`Owned process ${pid} did not stop`)
      }
    }
  }
}

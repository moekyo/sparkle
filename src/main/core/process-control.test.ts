import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createOwnedProcessControl } from './owned-process-control'

test('owned process control refuses to signal a reused PID with a different identity', async () => {
  const signals: NodeJS.Signals[] = []
  const control = createOwnedProcessControl({
    isAlive: async (_pid, identity) => identity === 'original-process',
    sendSignal: (_pid, signal) => signals.push(signal),
    delay: async () => {}
  })

  await control.stop(321, 'reused-process')

  assert.deepEqual(signals, [])
})

test('owned process control signals only the matching process identity', async () => {
  const signals: NodeJS.Signals[] = []
  let alive = true
  const control = createOwnedProcessControl({
    isAlive: async (_pid, identity) => identity === 'original-process' && alive,
    sendSignal: (_pid, signal) => {
      signals.push(signal)
      if (signal === 'SIGINT') alive = false
    },
    delay: async () => {}
  })

  await control.stop(321, 'original-process')

  assert.deepEqual(signals, ['SIGINT'])
})

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createDNSResolverProbe } from './dns-resolver'

function dnsError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code })
}

test('accepts NXDOMAIN and NODATA as proof that the resolver answered', async () => {
  for (const code of ['ENOTFOUND', 'ENODATA']) {
    const servers: string[] = []
    const probe = createDNSResolverProbe({
      timeoutMs: 50,
      createResolver: () => ({
        setServers: (values) => servers.push(...values),
        resolve4: async () => Promise.reject(dnsError(code)),
        cancel: () => {}
      })
    })

    assert.equal(await probe('2001:db8::53', new AbortController().signal), true)
    assert.deepEqual(servers, ['2001:db8::53'])
  }
})

test('rejects SERVFAIL, REFUSED, and other resolver errors as unavailable', async () => {
  for (const code of ['ESERVFAIL', 'EREFUSED', 'ETIMEOUT']) {
    const probe = createDNSResolverProbe({
      timeoutMs: 50,
      createResolver: () => ({
        setServers: () => {},
        resolve4: async () => Promise.reject(dnsError(code)),
        cancel: () => {}
      })
    })

    assert.equal(await probe('127.0.0.1', new AbortController().signal), false, code)
  }
})

test('cancels the underlying resolver on probe timeout', async () => {
  let cancelled = 0
  const probe = createDNSResolverProbe({
    timeoutMs: 10,
    createResolver: () => ({
      setServers: () => {},
      resolve4: () => new Promise<string[]>(() => {}),
      cancel: () => cancelled++
    })
  })

  assert.equal(await probe('127.0.0.1', new AbortController().signal), false)
  assert.equal(cancelled, 1)
})

test('cancels the underlying resolver when its reconcile generation is aborted', async () => {
  let cancelled = 0
  let started!: () => void
  const queryStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const controller = new AbortController()
  const probe = createDNSResolverProbe({
    timeoutMs: 500,
    createResolver: () => ({
      setServers: () => {},
      resolve4: () => {
        started()
        return new Promise<string[]>(() => {})
      },
      cancel: () => cancelled++
    })
  })
  const pending = probe('::1', controller.signal)

  await queryStarted
  controller.abort()

  assert.equal(await pending, false)
  assert.equal(cancelled, 1)
})

test('rejects invalid DNS server addresses without starting a query', async () => {
  let queried = false
  const probe = createDNSResolverProbe({
    createResolver: () => ({
      setServers: () => {
        throw new Error('invalid server')
      },
      resolve4: async () => {
        queried = true
        return []
      },
      cancel: () => {}
    })
  })

  assert.equal(await probe('not-an-ip', new AbortController().signal), false)
  assert.equal(queried, false)
})

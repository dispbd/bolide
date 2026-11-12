import { after, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp, createLogger, defineModule, defineRoute, HttpError } from '@bolide/core'
import { checkKey, createStorage, diskStorage, memoryStorage, presignV4, readUpload, s3Storage, signV4, Storage, storageModule } from '../src/index.ts'

const quiet = createLogger({ write: () => {} })

describe('keys', () => {
  test('relative paths pass, traversal and oddities do not', () => {
    assert.equal(checkKey('avatars/42.png'), 'avatars/42.png')
    for (const bad of ['', '/etc/passwd', '../x', 'a/../b', 'a//b', 'a/.hidden', '.meta/x', 'a\\b', 'a\nb', 'x'.repeat(513)]) {
      assert.throws(() => checkKey(bad), /storage key/, JSON.stringify(bad))
    }
  })
})

const tmp: string[] = []
after(() => Promise.all(tmp.map((d) => rm(d, { recursive: true, force: true }))))

for (const [name, make] of [
  ['memory', async () => memoryStorage()],
  ['disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bolide-storage-'))
    tmp.push(dir)
    return diskStorage(dir)
  }],
] as const) {
  describe(`Storage on ${name}`, () => {
    test('put, read back, head, delete', async () => {
      const storage = createStorage(await make())
      const info = await storage.put('docs/a.txt', 'hello')
      assert.deepEqual([info.key, info.size, info.contentType], ['docs/a.txt', 5, 'text/plain; charset=utf-8'])
      assert.equal(await storage.text('docs/a.txt'), 'hello')
      assert.equal((await storage.head('docs/a.txt'))?.size, 5)
      assert.equal(await storage.exists('docs/b.txt'), false)
      await storage.put('docs/a.txt', new Blob(['{"a":1}'], { type: 'application/json' }))
      assert.equal((await storage.head('docs/a.txt'))?.contentType, 'application/json')
      await storage.delete('docs/a.txt')
      assert.equal(await storage.get('docs/a.txt'), undefined)
      await storage.delete('docs/a.txt') // deleting twice is fine
    })

    test('streams in, with a size limit', async () => {
      const storage = createStorage(await make())
      const stream = () => new Blob([new Uint8Array(1000)]).stream()
      assert.equal((await storage.put('big.bin', stream())).size, 1000)
      await assert.rejects(storage.put('bigger.bin', stream(), { maxSize: 999 }), (e) => e instanceof HttpError && e.status === 413)
      assert.equal(await storage.exists('bigger.bin'), false)
    })
  })
}

describe('serving files', () => {
  test('response() sets type, length and nosniff; active types download unless inline', async () => {
    const storage = createStorage(memoryStorage())
    await storage.put('u/pic.png', new Uint8Array([1, 2, 3]))
    await storage.put('u/page.html', '<script>alert(1)</script>')
    const pic = await storage.response('u/pic.png')
    assert.deepEqual([pic.headers.get('content-type'), pic.headers.get('content-length'), pic.headers.get('x-content-type-options'), pic.headers.get('content-disposition')], ['image/png', '3', 'nosniff', null])
    assert.deepEqual([...new Uint8Array(await pic.arrayBuffer())], [1, 2, 3])
    assert.match((await storage.response('u/page.html')).headers.get('content-disposition')!, /^attachment; filename="page.html"/)
    assert.equal((await storage.response('u/page.html', { inline: true })).headers.get('content-disposition'), null)
    assert.match((await storage.response('u/pic.png', { download: 'my "pic".png' })).headers.get('content-disposition')!, /filename="my _pic_.png"; filename\*=UTF-8''my%20%22pic%22.png/)
    await assert.rejects(storage.response('u/none.png'), (e) => e instanceof HttpError && e.status === 404)
    await assert.rejects(storage.url('u/pic.png'), /no direct URLs/)
  })

  test('uploads through a route, with readUpload limits', async () => {
    const upload = defineRoute({
      method: 'POST',
      path: '/avatar',
      inject: { storage: Storage },
      handler: async ({ request }, { storage }) => {
        const file = await readUpload(request, { maxSize: 100, types: ['image/*'] })
        return storage.put(`avatars/${file.name}`, file)
      },
    })
    const show = defineRoute({ method: 'GET', path: '/avatar/:name', inject: { storage: Storage }, handler: ({ params }, { storage }) => storage.response(`avatars/${params.name}`) })
    const app = await createApp({ modules: [storageModule(), defineModule({ name: 'files', routes: [upload, show] })], logger: quiet })
    const send = (blob: Blob, name = 'a.png', field = 'file') => {
      const form = new FormData()
      form.set(field, blob, name)
      return app.fetch(new Request('http://x/avatar', { method: 'POST', body: form }))
    }
    const ok = await send(new Blob([new Uint8Array(10)], { type: 'image/png' }))
    assert.equal(ok.status, 200)
    assert.deepEqual(await ok.json().then((j) => [j.key, j.size, j.contentType]), ['avatars/a.png', 10, 'image/png'])
    assert.equal((await app.fetch(new Request('http://x/avatar/a.png'))).headers.get('content-type'), 'image/png')
    assert.equal((await send(new Blob([new Uint8Array(101)], { type: 'image/png' }))).status, 413)
    assert.equal((await send(new Blob(['x'], { type: 'text/html' }), 'a.html')).status, 415)
    assert.equal((await send(new Blob(['x'], { type: 'image/png' }), 'a.png', 'other')).status, 400)
    assert.equal((await app.fetch(new Request('http://x/avatar', { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain' } }))).status, 415)
  })
})

describe('S3', () => {
  const creds = { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', service: 's3', amzDate: '20130524T000000Z' }

  test('signV4 matches the AWS documentation example (GET object with Range)', () => {
    const auth = signV4({
      ...creds,
      method: 'GET',
      url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'),
      headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    })
    assert.equal(
      auth,
      'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41',
    )
  })

  test('presignV4 matches the AWS documentation example', () => {
    const url = new URL(presignV4({ ...creds, method: 'GET', url: new URL('https://examplebucket.s3.amazonaws.com/test.txt'), expiresIn: 86400 }))
    assert.equal(url.searchParams.get('X-Amz-Signature'), 'aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404')
  })

  test('s3Storage talks to an S3-compatible endpoint', async () => {
    const objects = new Map<string, { body: Buffer; type: string }>()
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url} ${String(req.headers.authorization).slice(0, 16)}`)
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const o = objects.get(req.url!)
        if (req.method === 'PUT') {
          objects.set(req.url!, { body: Buffer.concat(chunks), type: String(req.headers['content-type']) })
          return res.end()
        }
        if (req.method === 'DELETE') {
          objects.delete(req.url!)
          res.statusCode = 204
          return res.end()
        }
        if (!o) {
          res.statusCode = 404
          return res.end('<Error/>')
        }
        res.writeHead(200, { 'content-type': o.type, 'content-length': o.body.length, 'last-modified': new Date(0).toUTCString() })
        res.end(req.method === 'HEAD' ? undefined : o.body)
      })
    })
    await new Promise<void>((r) => server.listen(0, r))
    try {
      const endpoint = `http://localhost:${(server.address() as { port: number }).port}`
      const storage = createStorage(s3Storage({ bucket: 'files', region: 'auto', accessKeyId: 'k', secretAccessKey: 's', endpoint }))
      await storage.put('a b/c.txt', 'hi there')
      assert.equal(await storage.text('a b/c.txt'), 'hi there')
      assert.equal((await storage.head('a b/c.txt'))?.contentType, 'text/plain; charset=utf-8')
      assert.equal(await storage.exists('missing.txt'), false)
      await storage.delete('a b/c.txt')
      assert.deepEqual(seen.map((s) => s.split(' ').slice(0, 2).join(' ')), ['PUT /files/a%20b/c.txt', 'GET /files/a%20b/c.txt', 'HEAD /files/a%20b/c.txt', 'HEAD /files/missing.txt', 'DELETE /files/a%20b/c.txt'])
      assert.ok(seen.every((s) => s.endsWith('AWS4-HMAC-SHA256')))
      const url = new URL(await storage.url('a b/c.txt', { expiresIn: '1h' }))
      assert.equal(url.pathname, '/files/a%20b/c.txt')
      assert.equal(url.searchParams.get('X-Amz-Expires'), '3600')
      await assert.rejects(storage.url('x', { expiresIn: '8d' }), /between 1 second and 7 days/)
    } finally {
      server.close()
    }
  })

  test('missing settings fail at definition', () => {
    assert.throws(() => s3Storage({ bucket: '', region: 'x', accessKeyId: 'k', secretAccessKey: 's' }), /needs bucket/)
  })
})

describe('diskStorage', () => {
  test('writes files and metadata under its root only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bolide-storage-'))
    tmp.push(dir)
    const storage = createStorage(diskStorage(dir))
    await storage.put('x/y.json', '{}')
    assert.deepEqual((await readdir(dir)).sort(), ['.meta', 'x'])
    assert.equal((await storage.head('x/y.json'))?.contentType, 'application/json')
  })
})

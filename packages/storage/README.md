# @bolide/storage

Files for Bolide apps: one `Storage` service over memory, a local directory, or S3 and S3-compatible services (R2, MinIO, Backblaze...), plus a helper for uploads.

```ts
import { readUpload, s3Storage, Storage, storageModule } from '@bolide/storage'

const upload = defineRoute({
  method: 'POST',
  path: '/avatar',
  use: [authenticated],
  inject: { storage: Storage, session: CurrentSession },
  handler: async ({ request }, { storage, session }) => {
    const file = await readUpload(request, { maxSize: 2_000_000, types: ['image/png', 'image/jpeg'] })
    return storage.put(`avatars/${session.userId}.img`, file)
  },
})

const avatar = defineRoute({
  method: 'GET',
  path: '/avatar/:id',
  inject: { storage: Storage },
  handler: ({ params }, { storage }) => storage.response(`avatars/${params.id}.img`),
})

createApp({ modules: [storageModule({ driver: s3Storage({ bucket, region, accessKeyId, secretAccessKey }) }), files] })
```

## Storage

- `put(key, body, { contentType, maxSize })`: body is a string, bytes, a `Blob`/`File` or a stream. The type comes from the option, the Blob, or the key's extension.
- `get(key)` (a stream with size, type and date), `bytes`, `text`, `head`, `exists`, `delete`.
- `response(key, { download, inline, cacheControl })`: a `Response` for a route, or a 404. It sets `nosniff`, and HTML, SVG and XML are sent as downloads unless `inline: true`, so a user's upload can't run scripts on your origin.
- `url(key, { expiresIn })`: a presigned URL (S3), default 15 minutes, at most 7 days.

Keys are relative paths (`avatars/42.png`). Leading slashes, `.` and `..` segments, hidden segments, backslashes and control characters are refused, so a key can never leave its folder. Don't build keys from upload file names; use ids.

## Uploads

`readUpload(request, { maxSize, types, field })` reads one file from a `multipart/form-data` body in a route without a `body` schema. It answers 415 for other content types or disallowed file types (`image/*` works), 413 for oversized requests (checked before reading when `Content-Length` says so) and 400 when the field is missing.

## Drivers

| Driver | Use |
|---|---|
| `memoryStorage()` (default) | Tests; `keys()` lists what was stored. |
| `diskStorage(dir)` | One server. Writes are atomic (temp file and rename); content types are kept in `dir/.meta`. |
| `s3Storage({ bucket, region, accessKeyId, secretAccessKey, endpoint })` | S3 or any S3-compatible service. Requests are signed with SigV4 over `fetch`, without the AWS SDK. Uploads go in one request, so they are held in memory. |

`signV4` and `presignV4` are exported for other S3 calls; they are tested against the examples in the AWS documentation.

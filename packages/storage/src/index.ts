import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { ApiError, awsCredentials, requireSecret, seal, unseal } from "@dispatchmail/core";

export interface Storage {
  put(key: string, bytes: Buffer | NodeJS.ReadableStream, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  stream(key: string): Promise<NodeJS.ReadableStream>;
  url(key: string, options: { filename: string; expiresIn: number }): Promise<{ download_url: string; expires_at: string }>;
  delete(key: string): Promise<void>;
}

const signedUrlTtl = 60 * 60;

export function assertStorageKey(storageKey: string) {
  const four = /^(attachments|received)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
  const three = /^(raw|imports)\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+$/;
  // The SES receipt rule writes `<prefix><messageId>`, so a `raw/` prefix gives a two-part key.
  const inbound = /^raw\/[A-Za-z0-9_-]+$/;
  if (!four.test(storageKey) && !three.test(storageKey) && !inbound.test(storageKey)) {
    throw new ApiError("invalid_storage_key", 400, "Invalid storage key");
  }
}

function safePath(root: string, storageKey: string) {
  assertStorageKey(storageKey);
  const base = resolve(root);
  const path = resolve(base, storageKey);
  const child = relative(base, path);
  if (child.startsWith("..") || child === "" || child.startsWith("/")) {
    throw new ApiError("invalid_storage_key", 400, "Invalid storage key");
  }
  return path;
}

// Header values must be Latin-1 with no control characters. The ASCII name is the fallback, and
// `filename*` carries the real one (RFC 6266).
export function contentDisposition(filename: string) {
  const clean = filename.replace(/[\u0000-\u001f\u007f]/g, "");
  const fallback = clean.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "") || "file";
  const encoded = encodeURIComponent(clean || "file").replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// `pnpm dev` starts each app in its own directory. A relative storage directory resolves against
// the workspace root so the API and the worker read the same files.
export function storageRoot(dir = ".dispatch/storage", cwd = process.cwd()) {
  let base = resolve(cwd);
  for (;;) {
    if (existsSync(join(base, "pnpm-workspace.yaml"))) break;
    const parent = dirname(base);
    if (parent === base) {
      base = resolve(cwd);
      break;
    }
    base = parent;
  }
  return resolve(base, dir);
}

async function readBody(body: Buffer | NodeJS.ReadableStream) {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export function localStorage(options: { root: string; publicUrl: string; secret: string }): Storage {
  const publicUrl = options.publicUrl.replace(/\/$/, "");
  return {
    async put(key, bytes) {
      const path = safePath(options.root, key);
      await mkdir(dirname(path), { recursive: true });
      if (Buffer.isBuffer(bytes)) await writeFile(path, bytes);
      else await pipeline(bytes, createWriteStream(path));
    },
    async get(key) {
      return readFile(safePath(options.root, key));
    },
    async stream(key) {
      return createReadStream(safePath(options.root, key));
    },
    async url(key, urlOptions) {
      assertStorageKey(key);
      const expiresIn = urlOptions.expiresIn || signedUrlTtl;
      const exp = Math.floor(Date.now() / 1000) + expiresIn;
      const token = seal({ use: "file", key, filename: urlOptions.filename, exp }, options.secret);
      return {
        download_url: `${publicUrl}/files/${token}`,
        expires_at: new Date(exp * 1000).toISOString()
      };
    },
    async delete(key) {
      await rm(safePath(options.root, key), { force: true });
    }
  };
}

export type ObjectClient = {
  send(command: unknown): Promise<{ Body?: { transformToByteArray?: () => Promise<Uint8Array> } | Readable | Uint8Array | Buffer }>;
};

export type StreamUpload = (params: { Bucket: string; Key: string; Body: NodeJS.ReadableStream; ContentType?: string }) => Promise<void>;

export function s3Storage(options: {
  bucket: string;
  client: ObjectClient;
  signer?: (command: GetObjectCommand, expiresIn: number) => Promise<string>;
  now?: () => number;
  upload?: StreamUpload;
}): Storage {
  const signer = options.signer ?? ((command, expiresIn) => getSignedUrl(options.client as S3Client, command, { expiresIn }));
  const now = options.now ?? Date.now;
  // A stream has no known length, which a single PutObject needs. A multipart upload sends it
  // in parts as it arrives, so a 200 MB contact import is never held in memory.
  const upload: StreamUpload =
    options.upload ??
    (async (params) => {
      await new Upload({ client: options.client as S3Client, params: { ...params, Body: params.Body as Readable } }).done();
    });
  return {
    async put(key, bytes, contentType) {
      assertStorageKey(key);
      if (!Buffer.isBuffer(bytes)) {
        await upload({ Bucket: options.bucket, Key: key, Body: bytes, ContentType: contentType });
        return;
      }
      await options.client.send(new PutObjectCommand({
        Bucket: options.bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType
      }));
    },
    async get(key) {
      assertStorageKey(key);
      const result = await options.client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      const body = result.Body;
      if (!body) throw new ApiError("not_found", 404, "Object not found");
      if (Buffer.isBuffer(body)) return body;
      if (body instanceof Uint8Array) return Buffer.from(body);
      if (typeof (body as { transformToByteArray?: () => Promise<Uint8Array> }).transformToByteArray === "function") {
        return Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray());
      }
      return readBody(body as Readable);
    },
    // The object's body is handed on as it downloads. Only a body that is not a stream, which a
    // test client may return, is read whole first.
    async stream(key) {
      assertStorageKey(key);
      const result = await options.client.send(new GetObjectCommand({ Bucket: options.bucket, Key: key }));
      const body = result.Body;
      if (!body) throw new ApiError("not_found", 404, "Object not found");
      if (body instanceof Readable) return body;
      if (Buffer.isBuffer(body) || body instanceof Uint8Array) return Readable.from([Buffer.from(body)]);
      return Readable.from([Buffer.from(await (body as { transformToByteArray: () => Promise<Uint8Array> }).transformToByteArray())]);
    },
    async url(key, urlOptions) {
      assertStorageKey(key);
      const expiresIn = urlOptions.expiresIn || signedUrlTtl;
      const command = new GetObjectCommand({
        Bucket: options.bucket,
        Key: key,
        ResponseContentDisposition: contentDisposition(urlOptions.filename)
      });
      const download_url = await signer(command, expiresIn);
      return {
        download_url,
        expires_at: new Date(now() + expiresIn * 1000).toISOString()
      };
    },
    async delete(key) {
      assertStorageKey(key);
      await options.client.send(new DeleteObjectCommand({ Bucket: options.bucket, Key: key }));
    }
  };
}

export function createStorage(env: NodeJS.ProcessEnv = process.env): Storage {
  if ((env.STORAGE_BACKEND ?? "local") === "s3") {
    const region = env.AWS_REGION || "us-east-1";
    // S3_ENDPOINT points the client at an S3-compatible store, such as MinIO for local work.
    // Those stores address buckets by path, not by hostname.
    const endpoint = env.S3_ENDPOINT || undefined;
    return s3Storage({
      bucket: env.S3_BUCKET ?? "",
      client: new S3Client(endpoint ? { region, endpoint, forcePathStyle: true, credentials: awsCredentials() } : { region, credentials: awsCredentials() })
    });
  }
  return localStorage({
    root: storageRoot(env.STORAGE_DIR || undefined),
    publicUrl: env.PUBLIC_URL ?? "http://localhost:3100",
    secret: requireSecret("APP_SECRET", env)
  });
}

export async function readSignedFile(token: string, storage: Storage, secret: string) {
  const payload = unseal<{ use?: string; key?: string; filename?: string; exp?: number }>(token, secret);
  if (!payload || payload.use !== "file" || !payload.key) throw new ApiError("not_found", 404, "File not found");
  try {
    assertStorageKey(payload.key);
  } catch {
    throw new ApiError("not_found", 404, "File not found");
  }
  const bytes = await storage.get(payload.key);
  return { filename: payload.filename ?? "file", bytes };
}

export { signedUrlTtl };

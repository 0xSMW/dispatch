import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { ApiError } from "@dispatchmail/core";
import { contentDisposition, localStorage, readSignedFile, s3Storage, signedUrlTtl, storageRoot } from "./index.js";

describe("local storage", () => {
  let root = "";

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("stores a blob and signs a one-hour download url", async () => {
    root = await mkdtemp(join(tmpdir(), "dispatch-storage-"));
    const storage = localStorage({ root, publicUrl: "http://localhost:3100/", secret: "test-secret" });
    await storage.put("attachments/tenant_1/email_1/att_1", Buffer.from("hello"));
    await expect(storage.get("attachments/tenant_1/email_1/att_1")).resolves.toEqual(Buffer.from("hello"));
    const signed = await storage.url("attachments/tenant_1/email_1/att_1", { filename: "note.txt", expiresIn: signedUrlTtl });
    expect(signed.download_url.startsWith("http://localhost:3100/files/")).toBe(true);
    expect(Date.parse(signed.expires_at)).toBeGreaterThan(Date.now() + 50 * 60 * 1000);
    const token = signed.download_url.split("/files/")[1];
    await expect(readSignedFile(token, storage, "test-secret")).resolves.toMatchObject({ filename: "note.txt" });
    await expect(readSignedFile(token, storage, "other")).rejects.toMatchObject({ name: "not_found", statusCode: 404 });
  });

  it("rejects a key that escapes the storage root", async () => {
    root = await mkdtemp(join(tmpdir(), "dispatch-storage-"));
    const storage = localStorage({ root, publicUrl: "http://localhost:3100", secret: "test-secret" });
    await expect(storage.put("attachments/../../etc/passwd", Buffer.from("no"))).rejects.toBeInstanceOf(ApiError);
    await expect(storage.get("other/only-one")).rejects.toMatchObject({ name: "invalid_storage_key" });
    await expect(storage.get("raw/a/b/c")).rejects.toMatchObject({ name: "invalid_storage_key" });
    await storage.put("raw/tenant_1/recv_1", Buffer.from("mime"));
    await expect(storage.get("raw/tenant_1/recv_1")).resolves.toEqual(Buffer.from("mime"));
  });

  it("accepts the two-part key the SES receipt rule writes", async () => {
    root = await mkdtemp(join(tmpdir(), "dispatch-storage-"));
    const storage = localStorage({ root, publicUrl: "http://localhost:3100", secret: "test-secret" });
    await storage.put("raw/0abc1def2ghi", Buffer.from("mime"));
    await expect(storage.get("raw/0abc1def2ghi")).resolves.toEqual(Buffer.from("mime"));
  });

  it("writes a stream without buffering it first", async () => {
    root = await mkdtemp(join(tmpdir(), "dispatch-storage-"));
    const storage = localStorage({ root, publicUrl: "http://localhost:3100", secret: "test-secret" });
    await storage.put("imports/tenant_1/import_1", Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]));
    await expect(storage.get("imports/tenant_1/import_1")).resolves.toEqual(Buffer.from("a,b\n1,2\n"));
  });
});

describe("contentDisposition", () => {
  it("keeps an ASCII name and adds the encoded form", () => {
    expect(contentDisposition("note.txt")).toBe(`attachment; filename="note.txt"; filename*=UTF-8''note.txt`);
  });

  it("gives a header-safe fallback for names outside Latin-1", () => {
    const value = contentDisposition("文件 \"x\".pdf");
    expect(value).toBe(`attachment; filename="__ x.pdf"; filename*=UTF-8''%E6%96%87%E4%BB%B6%20%22x%22.pdf`);
    expect(/^[\x20-\x7e]+$/.test(value)).toBe(true);
  });

  it("drops control characters", () => {
    expect(contentDisposition("a\r\nSet-Cookie: x.txt")).toBe(
      `attachment; filename="aSet-Cookie: x.txt"; filename*=UTF-8''aSet-Cookie%3A%20x.txt`,
    );
  });
});

describe("storageRoot", () => {
  it("resolves a relative directory against the workspace root from any app directory", () => {
    const fromApi = storageRoot(".dispatch/storage", join(process.cwd(), "apps/api"));
    const fromWorker = storageRoot(".dispatch/storage", join(process.cwd(), "apps/worker"));
    expect(fromApi).toBe(fromWorker);
    expect(fromApi.endsWith(join(".dispatch", "storage"))).toBe(true);
  });

  it("leaves an absolute directory alone", () => {
    expect(storageRoot("/var/lib/dispatch")).toBe("/var/lib/dispatch");
  });
});

describe("s3 storage", () => {
  it("puts, reads, signs, and deletes through the injected client", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: { constructor: { name: string } }) => {
        sent.push(command);
        if (command instanceof GetObjectCommand) {
          return { Body: { transformToByteArray: async () => Uint8Array.from(Buffer.from("png")) } };
        }
        return {};
      })
    };
    const signer = vi.fn(async (command: GetObjectCommand) => `https://bucket.example/${command.input.Key}?sig=1`);
    const now = 1_700_000_000_000;
    const storage = s3Storage({ bucket: "mail", client, signer, now: () => now });
    await storage.put("attachments/tenant_1/email_1/att_1", Buffer.from("png"), "image/png");
    await expect(storage.get("attachments/tenant_1/email_1/att_1")).resolves.toEqual(Buffer.from("png"));
    const signed = await storage.url("attachments/tenant_1/email_1/att_1", { filename: "pic.png", expiresIn: 3600 });
    expect(signed).toEqual({
      download_url: "https://bucket.example/attachments/tenant_1/email_1/att_1?sig=1",
      expires_at: new Date(now + 3600 * 1000).toISOString()
    });
    expect(signer.mock.calls[0][0].input.ResponseContentDisposition).toBe(`attachment; filename="pic.png"; filename*=UTF-8''pic.png`);
    await storage.delete("attachments/tenant_1/email_1/att_1");
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect((sent[0] as PutObjectCommand).input).toMatchObject({ Bucket: "mail", Key: "attachments/tenant_1/email_1/att_1", ContentType: "image/png" });
    expect(sent[1]).toBeInstanceOf(GetObjectCommand);
    expect(sent[2]).toBeInstanceOf(DeleteObjectCommand);
  });

  it("sends a stream as a multipart upload and hands a stored object on as a stream", async () => {
    const parts: Buffer[] = [];
    const upload = vi.fn(async (params: { Bucket: string; Key: string; Body: NodeJS.ReadableStream; ContentType?: string }) => {
      for await (const chunk of params.Body) parts.push(Buffer.from(chunk as Buffer));
    });
    const client = { send: vi.fn(async () => ({ Body: Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]) })) };
    const storage = s3Storage({ bucket: "mail", client, upload });

    await storage.put("imports/tenant_1/import_1", Readable.from([Buffer.from("a,b\n"), Buffer.from("1,2\n")]), "text/csv");
    // Never a single PutObject: that would need the whole file in memory to know its length.
    expect(client.send).not.toHaveBeenCalled();
    expect(upload.mock.calls[0]![0]).toMatchObject({ Bucket: "mail", Key: "imports/tenant_1/import_1", ContentType: "text/csv" });
    expect(Buffer.concat(parts).toString()).toBe("a,b\n1,2\n");

    const chunks: string[] = [];
    for await (const chunk of await storage.stream("imports/tenant_1/import_1")) chunks.push(String(chunk));
    expect(chunks).toEqual(["a,b\n", "1,2\n"]);
  });
});

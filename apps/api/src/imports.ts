import multipart from "@fastify/multipart";
import { ApiError, contactImportSchema, id, importStatuses } from "@dispatchmail/core";
import {
  assertImportRefs,
  createImport,
  cancelImport,
  findImport,
  importColumns,
  importKey,
  paginate,
  presentImport,
  presentPage,
  type Db,
  type ImportRow,
  type PagingParams,
} from "@dispatchmail/db";
import type { Storage } from "@dispatchmail/storage";
import type { FastifyInstance, FastifyRequest } from "fastify";

export const importFileLimit = 200 * 1024 * 1024;

const importFields = ["column_map", "on_conflict", "segments", "topics", "trigger_automations"];

export function registerImports(
  app: FastifyInstance,
  deps: {
    db: Db;
    storage: Pick<Storage, "put" | "delete">;
    paging: (request: FastifyRequest) => PagingParams;
  },
) {
  const { db, storage, paging } = deps;

  // Multipart is registered in its own scope so the parser only exists on the upload route.
  app.register(async (scope) => {
    await scope.register(multipart, { limits: { fileSize: importFileLimit, files: 1, fields: 10 } });

    scope.post("/contacts/imports", async (request) => {
      if (!request.isMultipart()) {
        throw new ApiError("validation_error", 422, "Send the CSV as multipart/form-data with a file part");
      }
      const tenantId = request.auth!.tenant_id;
      const importId = id("import");
      const storageKey = importKey(tenantId, importId);
      const fields: Record<string, unknown> = {};
      let stored = false;
      let triggerAutomations = false;
      try {
        for await (const part of request.parts()) {
          if (part.type === "field") {
            if (importFields.includes(part.fieldname)) fields[part.fieldname] = part.value;
            continue;
          }
          if (part.fieldname !== "file" || stored) {
            part.file.resume();
            continue;
          }
          // Set first: a client that disconnects mid-upload leaves a partial file to clean up.
          stored = true;
          await storage.put(storageKey, part.file, part.mimetype || "text/csv");
          if (part.file.truncated) throw tooLarge();
        }
        if (!stored) throw new ApiError("validation_error", 422, "file is required");
        const input = contactImportSchema.parse(fields);
        await assertImportRefs(db, tenantId, input.segments, input.topics);
        const row = await createImport(db, {
          id: importId,
          tenantId,
          storageKey,
          columnMap: input.column_map,
          onConflict: input.on_conflict,
          segments: input.segments,
          topics: input.topics,
          triggerAutomations: input.trigger_automations,
        });
        triggerAutomations = row!.trigger_automations ?? false;
      } catch (error) {
        if (stored) await storage.delete(storageKey).catch(() => undefined);
        throw uploadError(error);
      }
      return { object: "contact_import", id: importId, trigger_automations: triggerAutomations };
    });
  });

  app.get("/contacts/imports", async (request) => {
    const status = (request.query as { status?: string }).status;
    if (status && !(importStatuses as readonly string[]).includes(status)) {
      throw new ApiError("validation_error", 400, `status must be one of ${importStatuses.join(", ")}`);
    }
    const page = paging(request);
    const result = await paginate<ImportRow>(db, "contact_imports", request.auth!.tenant_id, { ...page, limit: page.limit ?? 10 }, {
      select: importColumns,
      where: status ? "status = $2" : undefined,
      params: status ? [status] : undefined,
    });
    return presentPage(result, presentImport);
  });

  app.get("/contacts/imports/:id", async (request) => {
    const row = await findImport(db, request.auth!.tenant_id, (request.params as { id: string }).id);
    return presentImport(row);
  });

  app.delete("/contacts/imports/:id", async (request) => {
    return presentImport(await cancelImport(db, request.auth!.tenant_id, (request.params as { id: string }).id));
  });
}

function tooLarge() {
  return new ApiError("validation_error", 413, "file must be 200 MB or smaller");
}

// Busboy's limit errors carry a FST_ code and a status. Keep the API's own error names.
export function uploadError(error: unknown) {
  if (error instanceof ApiError) return error;
  const code = (error as { code?: string }).code ?? "";
  if (code === "FST_REQ_FILE_TOO_LARGE") return tooLarge();
  if (code.startsWith("FST_")) {
    return new ApiError("validation_error", 422, error instanceof Error ? error.message : "Invalid upload");
  }
  return error;
}

import { Hono } from "hono";
import { join } from "@std/path";
import type OpenAI from "openai";
import type { Message } from "@tomat/shared";
import { contentToText } from "@tomat/shared";
import { sessionsRepo } from "../../db/repos/sessions.ts";
import { sessionAttachmentsDir } from "../../paths.ts";
import { AppError } from "../../shared/errors.ts";
import { newAttachmentId, newMessageId } from "../../shared/ids.ts";
import { bearerMiddleware, requireClient } from "../middleware/auth.ts";
import { loadCoreSettings } from "../../services/coreSettings.ts";
import { resolveEndpoint } from "../../services/endpointResolver.ts";
import { llmScheduler } from "../../services/llmScheduler.ts";
import { type LlmRequest } from "../../services/llmProvider.ts";

export function sessionsRoutes(): Hono {
  const r = new Hono();
  r.use("*", bearerMiddleware());

  r.get("/", (c) => {
    const me = requireClient(c);
    return c.json(sessionsRepo().list(me.id));
  });

  r.post("/", async (c) => {
    const me = requireClient(c);
    const body = (await readJson(c)) as { title?: string };
    return c.json(
      sessionsRepo().create({ ownerClientId: me.id, title: body.title }),
    );
  });

  r.get("/:id", (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    const messages = sessionsRepo().listMessages(session.id);
    return c.json({ ...session, messages });
  });

  r.patch("/:id", async (c) => {
    const me = requireClient(c);
    const body = (await readJson(c)) as { title?: string };
    if (typeof body.title !== "string") {
      throw new AppError("validation_error", "title is required");
    }
    sessionsRepo().patchTitle(me.id, c.req.param("id"), body.title);
    return c.json({ id: c.req.param("id"), title: body.title });
  });

  r.delete("/:id", async (c) => {
    const me = requireClient(c);
    const { attachmentPaths } = sessionsRepo().delete(me.id, c.req.param("id"));
    for (const p of attachmentPaths) {
      try {
        await Deno.remove(p);
      } catch { /* */ }
    }
    return c.body(null, 204);
  });

  r.post("/:id/messages", async (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    const msg = (await readJson(c)) as Message;
    return c.json(sessionsRepo().appendMessage(session.id, msg));
  });

  r.patch("/:id/messages/:msgId", async (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    const patch = (await readJson(c)) as Partial<Message>;
    return c.json(
      sessionsRepo().patchMessage(session.id, c.req.param("msgId"), patch),
    );
  });

  r.delete("/:id/messages/:msgId", (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    sessionsRepo().deleteMessage(session.id, c.req.param("msgId"));
    return c.body(null, 204);
  });

  r.post("/:id/attachments", async (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    const form = await c.req.formData();
    const file = form.get("file");
    const messageId = form.get("messageId");
    if (!(file instanceof File) || typeof messageId !== "string") {
      throw new AppError("validation_error", "file + messageId required");
    }
    const id = newAttachmentId();
    const dir = sessionAttachmentsDir(session.id);
    await Deno.mkdir(dir, { recursive: true });
    const filename = sanitizeFilename(file.name);
    const absPath = join(dir, `${id}_${filename}`);
    const bytes = new Uint8Array(await file.arrayBuffer());
    await Deno.writeFile(absPath, bytes);
    const rec = sessionsRepo().recordAttachment(
      session.id,
      messageId,
      filename,
      file.type || undefined,
      bytes.byteLength,
      absPath,
    );
    return c.json({ id: rec.id, absPath: rec.absPath, filename: rec.filename });
  });

  r.get("/:id/attachments/:attId", async (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    const rec = sessionsRepo().getAttachment(session.id, c.req.param("attId"));
    const file = await Deno.open(rec.absPath, { read: true });
    return new Response(file.readable, {
      status: 200,
      headers: { "Content-Type": rec.mime ?? "application/octet-stream" },
    });
  });

  // SSE chat fallback for non-WS clients (plan §4). One-shot completion —
  // no tool support, no reasoning trace, no multi-stream multiplexing. The
  // WS path (chat.start) covers all of those.
  //
  // Body: { content: string }
  // Response: text/event-stream with data lines:
  //   data: {"contentDelta":"hello"}
  //   data: {"contentDelta":" world"}
  //   data: {"done":true,"usage":{...}}
  //   data: {"error":"..."}                                  (terminal)
  r.post("/:id/chat", async (c) => {
    const me = requireClient(c);
    const session = sessionsRepo().getOrThrow(me.id, c.req.param("id"));
    const body = (await readJson(c)) as { content?: unknown };
    if (typeof body.content !== "string" || body.content.length === 0) {
      throw new AppError(
        "validation_error",
        "body must be { content: string }",
      );
    }

    // Persist the user message so the SSE response can be replayed from
    // session history later if the client refreshes.
    const userMsg: Message = {
      id: newMessageId(),
      role: "user",
      content: body.content,
      createdAtMs: Date.now(),
    } as Message;
    sessionsRepo().appendMessage(session.id, userMsg);

    const history = sessionsRepo().listMessages(session.id);
    const settings = await loadCoreSettings();
    const endpoint = await resolveEndpoint(settings, "default");
    const isLocal = strSetting(settings, "llm.provider", "local") === "local";
    const messages = historyToOpenAI(
      history,
      strSetting(settings, "llm.systemPrompt", ""),
    );

    const req: LlmRequest = { endpoint, messages };

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        let assistantText = "";
        let usage:
          | { prompt: number; completion: number; total: number }
          | undefined;
        try {
          for await (
            const delta of llmScheduler().schedule(req, {
              clientId: me.id,
              isLocal,
              parallelSlots: numSetting(settings, "llm.local.parallelSlots", 4),
            })
          ) {
            if (delta.contentDelta) {
              assistantText += delta.contentDelta;
              controller.enqueue(encoder.encode(
                `data: ${
                  JSON.stringify({ contentDelta: delta.contentDelta })
                }\n\n`,
              ));
            }
            if (delta.usage) usage = delta.usage;
          }
          // Persist the assistant turn.
          if (assistantText) {
            sessionsRepo().appendMessage(session.id, {
              id: newMessageId(),
              role: "assistant",
              content: assistantText,
              createdAtMs: Date.now(),
            } as Message);
          }
          controller.enqueue(encoder.encode(
            `data: ${JSON.stringify({ done: true, usage })}\n\n`,
          ));
        } catch (err) {
          controller.enqueue(encoder.encode(
            `data: ${
              JSON.stringify({
                error: err instanceof Error ? err.message : String(err),
              })
            }\n\n`,
          ));
        } finally {
          controller.close();
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
      },
    });
  });

  return r;
}

// --- helpers for the SSE fallback ----------------------------------------

function historyToOpenAI(
  history: Message[],
  systemPrompt: string,
): OpenAI.Chat.Completions.ChatCompletionMessageParam[] {
  const out: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of history) {
    // Only carry user/assistant/system through the fallback — tool messages
    // and reasoning are WS-path concerns. SSE doesn't transport images, so
    // multipart content collapses to its text parts (attachments inlined as
    // text are still useful; image bytes are dropped without warning).
    if (m.role === "user" || m.role === "assistant" || m.role === "system") {
      const text = contentToText(m.content);
      if (text.length > 0) out.push({ role: m.role, content: text });
    }
  }
  return out;
}

function strSetting(
  s: Record<string, unknown>,
  key: string,
  def: string,
): string {
  const v = s[key];
  return typeof v === "string" ? v : def;
}

function numSetting(
  s: Record<string, unknown>,
  key: string,
  def: number,
): number {
  const v = s[key];
  return typeof v === "number" ? v : def;
}

async function readJson(c: import("hono").Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    throw new AppError("validation_error", "invalid JSON body");
  }
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\0/\\]/g, "_").replace(/^\.+/, "");
}

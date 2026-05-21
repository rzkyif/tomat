import type { TtsStatusResponse, TtsSynthesizeRequest, TtsVoicesResponse } from "@tomat/shared";
import type { CoreClient } from "./client";

export class TtsApi {
  constructor(private readonly client: CoreClient) {}

  async load(): Promise<void> {
    await this.client.post("/api/v1/tts/load", {});
  }

  async unload(): Promise<void> {
    await this.client.post("/api/v1/tts/unload", {});
  }

  // Returns a WAV blob. Caller wraps with `new Audio(URL.createObjectURL(...))`
  // or feeds to AudioContext.decodeAudioData.
  async synthesize(req: TtsSynthesizeRequest): Promise<Blob> {
    const res = await fetch(`${this.client.endpoint.baseUrl}/api/v1/tts/synthesize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.client.endpoint.token}`,
      },
      body: JSON.stringify(req),
    });
    if (!res.ok) throw new Error(`tts synthesize HTTP ${res.status}`);
    return await res.blob();
  }

  voices(): Promise<TtsVoicesResponse> {
    return this.client.get("/api/v1/tts/voices");
  }

  status(): Promise<TtsStatusResponse> {
    return this.client.get("/api/v1/tts/status");
  }
}

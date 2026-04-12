import { createOpenAIClient } from "./llm";
import { settingsState } from "../state";

export async function transcribeAudio(
  audioData: string,
): Promise<{ text: string; error?: string }> {
  try {
    const settings = settingsState.currentSettings;
    const preset = settings["stt.preset"];
    const binaryString = atob(audioData);
    const bytes = new Uint8Array(binaryString.length);
    for (let i = 0; i < binaryString.length; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: "audio/wav" });

    if (preset === "external") {
      const client = createOpenAIClient(
        settings["stt.external.baseUrl"],
        settings["stt.external.apiKey"],
      );
      const file = new File([blob], "audio.wav", { type: "audio/wav" });
      const transcription = await client.audio.transcriptions.create({
        file,
        model: settings["stt.external.model"],
      });
      return { text: transcription.text.trim() };
    } else {
      // whisper-server native inference
      const host = settings["stt.host"] || "127.0.0.1";
      const port = settings["stt.port"] || "7702";

      const formData = new FormData();
      formData.append("file", blob, "input.wav");
      formData.append("model", "whisper-1");

      const response = await fetch(`http://${host}:${port}/inference`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      return { text: String(result.transcription ?? result.text ?? result.output ?? "").trim() };
    }
  } catch (err: any) {
    console.error(`[stt] Transcription error:`, err);
    return { text: "", error: err?.message || "Transcription failed" };
  }
}

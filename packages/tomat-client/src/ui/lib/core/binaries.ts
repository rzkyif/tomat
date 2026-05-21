import type {
  BinaryKind,
  BinaryManifest,
  InstallBinariesResponse,
  ListBinariesResponse,
  UpdateBinaryResponse,
} from "@tomat/shared";
import type { CoreClient } from "./client";

export class BinariesApi {
  constructor(private readonly client: CoreClient) {}

  list(): Promise<ListBinariesResponse> {
    return this.client.get("/api/v1/binaries");
  }

  install(kinds?: BinaryKind[]): Promise<InstallBinariesResponse> {
    return this.client.post("/api/v1/binaries/install", { kinds });
  }

  update(kind: BinaryKind, version?: string): Promise<UpdateBinaryResponse> {
    return this.client.post("/api/v1/binaries/update", { kind, version });
  }

  manifest(): Promise<BinaryManifest> {
    return this.client.get("/api/v1/binaries/manifest");
  }
}

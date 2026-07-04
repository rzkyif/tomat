// Unit coverage for the add-a-core wizard's state machine and the local
// "install on this computer" flow (NewCoreWizard). The class was previously
// only exercised transitively (Rust helpers below it, Core endpoints it calls,
// E2E harness re-implementing pairWithCode); nothing drove its own branch,
// routing, error, and window logic. These tests stub the platform + the
// $lib/core pairing free functions and drive the class directly.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { MIN_ADMIN_PASSWORD_LENGTH } from "@tomat/shared";
import { type Platform, setPlatform } from "$lib/platform";

// Hoisted spies so the vi.mock factories (which are hoisted above imports) can
// close over them. The wizard imports the pairing free functions + cores() from
// $lib/core, viewState/modelRecommendState from $stores, isTauri from env, and
// getLogger from log; all are replaced here so the class is tested in isolation.
const h = vi.hoisted(() => ({
  cores: {
    list: vi.fn<() => Promise<Array<{ baseUrl: string }>>>(),
    addPaired: vi.fn<(entry: unknown, token: string) => Promise<void>>(),
    select: vi.fn<(id: string) => Promise<void>>(),
  },
  mintCodeWithAdminToken: vi.fn(),
  pairWithCode: vi.fn(),
  probeCore: vi.fn(),
  setAdminPasswordWithToken: vi.fn(),
  viewState: {
    setLocked: vi.fn<(v: boolean) => void>(),
    navigate: vi.fn<(m: string) => void>(),
    pendingSettingsGroup: null as string | null,
  },
  modelRecommendState: { applyBucket: vi.fn<() => Promise<void>>() },
  isTauri: vi.fn<() => boolean>(),
}));

vi.mock("$lib/core", () => ({
  cores: () => h.cores,
  mintCodeWithAdminToken: h.mintCodeWithAdminToken,
  pairWithCode: h.pairWithCode,
  probeCore: h.probeCore,
  setAdminPasswordWithToken: h.setAdminPasswordWithToken,
}));
vi.mock("$stores", () => ({
  viewState: h.viewState,
  modelRecommendState: h.modelRecommendState,
}));
vi.mock("$lib/util/env", () => ({ isTauri: h.isTauri }));
vi.mock("$lib/util/log", () => ({
  getLogger: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// Imported after the mocks are declared (vi.mock is hoisted regardless).
import { hostFromUrl, NewCoreWizard } from "./use-new-core-wizard.svelte";

const LOCAL_URL = "https://127.0.0.1:7800";
const PAIR_RESULT = {
  token: "tok",
  clientId: "client-1",
  coreVersion: "1.2.3",
  trustMode: "pin" as const,
  tlsPin: "PIN",
};

// A fresh mock platform each test. Only the namespaces the wizard touches are
// populated; tests overwrite individual spies to drive specific branches. The
// inferred shape keeps the per-spy `.mockResolvedValue` overrides typed.
function makePlatform() {
  return {
    pairing: {
      readAdminToken: vi.fn<() => Promise<string | null>>(async () => "admin-token"),
      readLocalCoreBootError: vi.fn<() => Promise<string | null>>(async () => null),
      installLocalCore: vi.fn(async () => "123456"),
      subscribeInstallProgress: vi.fn<
        (cb: (p: { label: string; done: number; total: number }) => void) => Promise<() => void>
      >(async () => () => {}),
      enableCoreBehindProxy: vi.fn<(service: boolean) => Promise<void>>(async () => {}),
      isLocalCoreInstalled: vi.fn(async () => false),
      startLocalCore: vi.fn(async () => true),
      localCoreBaseUrl: vi.fn(async () => LOCAL_URL),
      localSidecarPorts: vi.fn(async () => ({ llm: 7701, stt: 7702 })),
      launchPrefill: vi.fn<() => Promise<{ coreUrl?: string; pairingCode?: string } | null>>(
        async () => null,
      ),
    },
    windowing: { requestHide: vi.fn(async () => {}), show: vi.fn(async () => {}) },
    net: { discoverCores: vi.fn(async () => []) },
  };
}

let plat: ReturnType<typeof makePlatform>;

beforeEach(() => {
  vi.clearAllMocks();
  plat = makePlatform();
  setPlatform(plat as unknown as Platform);
  h.cores.list.mockResolvedValue([]);
  h.cores.addPaired.mockResolvedValue(undefined);
  h.cores.select.mockResolvedValue(undefined);
  h.mintCodeWithAdminToken.mockResolvedValue({ code: "654321" });
  h.pairWithCode.mockResolvedValue(PAIR_RESULT);
  h.setAdminPasswordWithToken.mockResolvedValue(undefined);
  h.modelRecommendState.applyBucket.mockResolvedValue(undefined);
  h.viewState.pendingSettingsGroup = null;
  h.isTauri.mockReturnValue(true);
});

describe("hostFromUrl", () => {
  it("returns the host for a valid URL", () => {
    expect(hostFromUrl("https://a.b.com:7800/path")).toBe("a.b.com:7800");
  });
  it("falls back to a label for a non-URL", () => {
    expect(hostFromUrl("not a url")).toBe("Remote Core");
  });
});

describe("getters", () => {
  it("installPasswordValid requires a min length AND a matching confirm", () => {
    const w = new NewCoreWizard(false);
    const min = MIN_ADMIN_PASSWORD_LENGTH;
    w.installPassword = "x".repeat(min - 1);
    w.installPasswordConfirm = w.installPassword;
    expect(w.installPasswordValid).toBe(false); // too short

    w.installPassword = "x".repeat(min);
    w.installPasswordConfirm = "y".repeat(min);
    expect(w.installPasswordValid).toBe(false); // mismatch

    w.installPasswordConfirm = w.installPassword;
    expect(w.installPasswordValid).toBe(true);
  });

  it("canStepBack matches the header back-arrow condition", () => {
    const w = new NewCoreWizard(false);
    w.view = "remotePair";
    expect(w.canStepBack).toBe(true);
    w.view = "chooseDestination";
    expect(w.canStepBack).toBe(false);
    w.view = "remoteAddress";
    w.chooserSkipped = false;
    expect(w.canStepBack).toBe(true);
    w.chooserSkipped = true; // skipped chooser => back cancels, arrow hidden
    expect(w.canStepBack).toBe(false);
    w.view = "localConfirm";
    w.chooserSkipped = false;
    expect(w.canStepBack).toBe(true);
  });

  it("normalizedRemoteUrl coerces to https and trims", () => {
    const w = new NewCoreWizard(false);
    w.remoteUrl = "http://x:7800";
    expect(w.normalizedRemoteUrl()).toBe("https://x:7800");
    w.remoteUrl = "x:7800";
    expect(w.normalizedRemoteUrl()).toBe("https://x:7800");
    w.remoteUrl = "https://x:7800/";
    expect(w.normalizedRemoteUrl()).toBe("https://x:7800");
    w.remoteUrl = "   ";
    expect(w.normalizedRemoteUrl()).toBe("");
  });
});

describe("decideInitialView", () => {
  it("mobile skips the chooser and goes straight to the remote form", async () => {
    const w = new NewCoreWizard(true);
    await w.decideInitialView();
    expect(w.view).toBe("remoteAddress");
    expect(w.destination).toBe("remote");
    expect(w.chooserSkipped).toBe(true);
    // No on-device install probe on mobile.
    expect(plat.pairing.isLocalCoreInstalled).not.toHaveBeenCalled();
  });

  it("first-ever desktop launch opens the destination chooser", async () => {
    h.cores.list.mockResolvedValue([]);
    const w = new NewCoreWizard(false);
    await w.decideInitialView();
    expect(w.view).toBe("chooseDestination");
    expect(w.chooserSkipped).toBe(false);
  });

  it("skips the chooser when a local core is already paired", async () => {
    h.cores.list.mockResolvedValue([{ baseUrl: LOCAL_URL }]);
    const w = new NewCoreWizard(false);
    await w.decideInitialView();
    expect(w.view).toBe("remoteAddress");
    expect(w.chooserSkipped).toBe(true);
  });

  it("still shows the chooser when only a remote core is paired", async () => {
    h.cores.list.mockResolvedValue([{ baseUrl: "https://192.168.1.5:7800" }]);
    const w = new NewCoreWizard(false);
    await w.decideInitialView();
    expect(w.view).toBe("chooseDestination");
  });

  it("prefills empty remote fields from launch arguments", async () => {
    plat.pairing.launchPrefill.mockResolvedValue({
      coreUrl: "https://prefill:7800",
      pairingCode: "111111",
    });
    const w = new NewCoreWizard(false);
    await w.decideInitialView();
    expect(w.remoteUrl).toBe("https://prefill:7800");
    expect(w.remoteCode).toBe("111111");
  });

  it("does not clobber remote fields the user already typed", async () => {
    plat.pairing.launchPrefill.mockResolvedValue({
      coreUrl: "https://prefill:7800",
      pairingCode: "111111",
    });
    const w = new NewCoreWizard(false);
    w.remoteUrl = "https://typed:7800";
    w.remoteCode = "999999";
    await w.decideInitialView();
    expect(w.remoteUrl).toBe("https://typed:7800");
    expect(w.remoteCode).toBe("999999");
  });

  it("records that a local core binary is already installed", async () => {
    plat.pairing.isLocalCoreInstalled.mockResolvedValue(true);
    const w = new NewCoreWizard(false);
    await w.decideInitialView();
    expect(w.localAlreadyInstalled).toBe(true);
  });
});

describe("continueFromChoose", () => {
  it("routes the remote choice to the address form", async () => {
    const w = new NewCoreWizard(false);
    w.destination = "remote";
    await w.continueFromChoose();
    expect(w.view).toBe("remoteAddress");
  });

  it("errors when a local install is chosen without the desktop app", async () => {
    h.isTauri.mockReturnValue(false);
    const w = new NewCoreWizard(false);
    w.destination = "local";
    await w.continueFromChoose();
    expect(w.error).toMatch(/desktop app/i);
    expect(w.view).toBe("chooseDestination");
  });

  it("advances to the local-confirm page for a fresh local install", async () => {
    const w = new NewCoreWizard(false);
    w.destination = "local";
    w.localAlreadyInstalled = false;
    await w.continueFromChoose();
    expect(w.view).toBe("localConfirm");
    expect(w.installServiceChoice).toBe(false);
    expect(w.installNetworkChoice).toBe(false);
    expect(plat.pairing.installLocalCore).not.toHaveBeenCalled();
  });

  it("fast-paths an already-installed local core straight to pairing", async () => {
    const w = new NewCoreWizard(false);
    w.destination = "local";
    w.localAlreadyInstalled = true;
    await w.continueFromChoose();
    // No install script; it starts the core, mints via admin token, and claims.
    expect(plat.pairing.installLocalCore).not.toHaveBeenCalled();
    expect(plat.pairing.startLocalCore).toHaveBeenCalled();
    expect(h.mintCodeWithAdminToken).toHaveBeenCalledWith(LOCAL_URL, "admin-token");
    expect(h.pairWithCode).toHaveBeenCalledWith(LOCAL_URL, "tomat Client", "654321", false);
    expect(w.error).toBe("");
    expect(w.busy).toBeNull();
  });
});

describe("pairLocal (install + pair)", () => {
  it("installs, sets the admin password, claims, and unlocks on the first core", async () => {
    const w = new NewCoreWizard(false);
    w.installServiceChoice = false;
    w.installNetworkChoice = false;
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();

    expect(plat.pairing.installLocalCore).toHaveBeenCalledWith({ service: false, bindAll: false });
    expect(h.setAdminPasswordWithToken).toHaveBeenCalledWith(
      LOCAL_URL,
      "admin-token",
      "hunter2-long",
    );
    expect(h.pairWithCode).toHaveBeenCalledWith(LOCAL_URL, "tomat Client", "123456", false);
    const [entry, token] = h.cores.addPaired.mock.calls[0];
    expect(entry).toMatchObject({ name: "Local Core", baseUrl: LOCAL_URL, trustMode: "pin" });
    expect(token).toBe("tok");
    expect(h.cores.select).toHaveBeenCalledWith("client-1");
    // First core ever: hardware-fit preset applied, UI unlocked, quick settings.
    expect(h.modelRecommendState.applyBucket).toHaveBeenCalledWith("smallest");
    expect(h.viewState.setLocked).toHaveBeenCalledWith(false);
    expect(h.viewState.navigate).toHaveBeenCalledWith("quickSettings");
    expect(w.busy).toBeNull();
    expect(w.error).toBe("");
  });

  it("passes the service/network toggles through to the installer", async () => {
    const w = new NewCoreWizard(false);
    w.installServiceChoice = false;
    w.installNetworkChoice = true;
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    expect(plat.pairing.installLocalCore).toHaveBeenCalledWith({ service: false, bindAll: true });
  });

  it("leaves the Core pinning when the behind-proxy option is off", async () => {
    const w = new NewCoreWizard(false);
    w.installBehindProxyChoice = false;
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    // Paired over loopback in pin mode; no flip.
    expect(h.pairWithCode).toHaveBeenCalledWith(LOCAL_URL, "tomat Client", "123456", false);
    expect(plat.pairing.enableCoreBehindProxy).not.toHaveBeenCalled();
  });

  it("flips the Core into behind-proxy mode after pairing when the option is on", async () => {
    const w = new NewCoreWizard(false);
    w.installServiceChoice = true;
    w.installBehindProxyChoice = true;
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    // The pair still runs in pin mode over loopback; only afterward is the Core
    // switched into behind-proxy mode, with the install's service choice.
    expect(h.pairWithCode).toHaveBeenCalledWith(LOCAL_URL, "tomat Client", "123456", false);
    expect(plat.pairing.enableCoreBehindProxy).toHaveBeenCalledWith(true);
    const pairOrder = h.pairWithCode.mock.invocationCallOrder[0];
    const flipOrder = plat.pairing.enableCoreBehindProxy.mock.invocationCallOrder[0];
    expect(flipOrder).toBeGreaterThan(pairOrder);
  });

  it("keeps the completed pairing when the behind-proxy flip fails", async () => {
    plat.pairing.enableCoreBehindProxy.mockRejectedValue(new Error("restart failed"));
    const w = new NewCoreWizard(false);
    w.installBehindProxyChoice = true;
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    // Pairing succeeded and the UI advanced; the flip failure is swallowed.
    expect(h.cores.addPaired).toHaveBeenCalled();
    expect(h.viewState.navigate).toHaveBeenCalled();
    expect(w.error).toBe("");
    expect(w.busy).toBeNull();
  });

  it("routes an additional core back to the Cores settings manager", async () => {
    h.cores.list.mockResolvedValue([{ baseUrl: "https://192.168.1.9:7800" }]);
    const w = new NewCoreWizard(false);
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    expect(h.modelRecommendState.applyBucket).not.toHaveBeenCalled();
    expect(h.viewState.setLocked).not.toHaveBeenCalled();
    expect(h.viewState.pendingSettingsGroup).toBe("cores");
    expect(h.viewState.navigate).toHaveBeenCalledWith("settings");
  });

  // Regression: a missing admin token used to silently skip setting the password
  // and pair anyway, leaving the Core with no admin password (and the user unable
  // to pair further devices). It must now fail loudly and NOT claim.
  it("fails loudly when the admin token is missing after install", async () => {
    plat.pairing.readAdminToken.mockResolvedValue(null);
    const w = new NewCoreWizard(false);
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();

    expect(plat.pairing.installLocalCore).toHaveBeenCalled(); // install ran
    expect(h.setAdminPasswordWithToken).not.toHaveBeenCalled();
    expect(h.pairWithCode).not.toHaveBeenCalled(); // pairing aborted
    expect(h.cores.addPaired).not.toHaveBeenCalled();
    expect(w.error).toMatch(/admin token not found/i);
    expect(w.busy).toBeNull();
  });

  it("streams installer phases into installProgress and clears them at the end", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    let progressCb: ((p: { label: string; done: number; total: number }) => void) | null = null;
    const unsubscribe = vi.fn(() => {});
    plat.pairing.subscribeInstallProgress.mockImplementation(async (cb) => {
      progressCb = cb;
      return unsubscribe;
    });
    plat.pairing.installLocalCore.mockImplementation(async () => {
      await gate;
      return "123456";
    });
    const w = new NewCoreWizard(false);
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";

    const done = w.pairLocal();
    await vi.waitFor(() => expect(progressCb).not.toBeNull());
    progressCb!({ label: "Downloading the Core", done: 2, total: 6 });
    expect(w.installProgress).toEqual({ label: "Downloading the Core", done: 2, total: 6 });

    release();
    await done;
    // Cleared once the flow resolves, and the subscription torn down.
    expect(w.installProgress).toBeNull();
    expect(unsubscribe).toHaveBeenCalled();
  });

  it("still installs when the progress subscription fails", async () => {
    plat.pairing.subscribeInstallProgress.mockRejectedValue(new Error("no event bus"));
    const w = new NewCoreWizard(false);
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    expect(plat.pairing.installLocalCore).toHaveBeenCalled();
    expect(w.error).toBe("");
    expect(w.busy).toBeNull();
  });

  it("folds the Core's boot-error breadcrumb into an install failure message", async () => {
    plat.pairing.installLocalCore.mockRejectedValue(new Error("could not reach the core"));
    plat.pairing.readLocalCoreBootError.mockResolvedValue("port 7800 already in use");
    const w = new NewCoreWizard(false);
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";
    await w.pairLocal();
    expect(w.error).toContain("could not reach the core");
    expect(w.error).toContain("port 7800 already in use");
    expect(w.busy).toBeNull();
  });
});

describe("pairLocalAlreadyInstalled (via continueFromChoose)", () => {
  async function runAlreadyInstalled(w: NewCoreWizard): Promise<void> {
    w.destination = "local";
    w.localAlreadyInstalled = true;
    await w.continueFromChoose();
  }

  it("throws a clear error when the on-disk admin token is missing", async () => {
    plat.pairing.readAdminToken.mockResolvedValue(null);
    const w = new NewCoreWizard(false);
    await runAlreadyInstalled(w);
    expect(w.error).toMatch(/admin token not found/i);
    expect(h.mintCodeWithAdminToken).not.toHaveBeenCalled();
    expect(w.busy).toBeNull();
  });

  it("errors when the mint response carries no code", async () => {
    h.mintCodeWithAdminToken.mockResolvedValue({ code: "" });
    const w = new NewCoreWizard(false);
    await runAlreadyInstalled(w);
    expect(w.error).toMatch(/missing pairing code/i);
    expect(h.pairWithCode).not.toHaveBeenCalled();
    expect(w.busy).toBeNull();
  });
});

describe("continueInBackground", () => {
  it("is a no-op unless an install is actually running", async () => {
    const w = new NewCoreWizard(false);
    w.busy = null;
    await w.continueInBackground();
    expect(plat.windowing.requestHide).not.toHaveBeenCalled();
  });

  it("hides the always-on-top setup window mid-install", async () => {
    const w = new NewCoreWizard(false);
    w.busy = "installing";
    await w.continueInBackground();
    expect(plat.windowing.requestHide).toHaveBeenCalledTimes(1);
  });

  it("re-shows the window once a backgrounded install resolves", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    plat.pairing.installLocalCore.mockImplementation(async () => {
      await gate;
      return "123456";
    });
    const w = new NewCoreWizard(false);
    w.installPassword = "hunter2-long";
    w.installPasswordConfirm = "hunter2-long";

    const done = w.pairLocal();
    expect(w.busy).toBe("installing"); // set synchronously before the first await
    await w.continueInBackground();
    expect(plat.windowing.requestHide).toHaveBeenCalledTimes(1);

    release();
    await done;
    expect(plat.windowing.show).toHaveBeenCalledTimes(1);
  });
});

describe("navigation helpers", () => {
  it("goBack steps remotePair -> remoteAddress and clears the error", () => {
    const w = new NewCoreWizard(false);
    w.view = "remotePair";
    w.error = "boom";
    w.goBack();
    expect(w.view).toBe("remoteAddress");
    expect(w.error).toBe("");
  });

  it("goBack steps localConfirm -> chooseDestination", () => {
    const w = new NewCoreWizard(false);
    w.view = "localConfirm";
    w.goBack();
    expect(w.view).toBe("chooseDestination");
  });

  it("goBack is inert while busy", () => {
    const w = new NewCoreWizard(false);
    w.view = "remotePair";
    w.busy = "claiming";
    w.goBack();
    expect(w.view).toBe("remotePair");
  });

  it("exitFlow returns to the Cores settings manager", () => {
    const w = new NewCoreWizard(false);
    w.exitFlow();
    expect(h.viewState.pendingSettingsGroup).toBe("cores");
    expect(h.viewState.navigate).toHaveBeenCalledWith("settings");
  });
});

// Hardware-introspection helper for tomat-core.
//
// Detects total/available RAM and physical CPU cores (via sysinfo) plus the GPU
// backend and VRAM (via platform probes: system_profiler on macOS, nvidia-smi,
// rocm-smi), then prints one JSON object on stdout. The core's fit engine reads
// it to size local models. Detection degrades gracefully to a CPU backend when
// no GPU probe succeeds; this binary never fails the caller.

use serde::Serialize;
use std::process::Command;
use sysinfo::System;

#[derive(Serialize)]
struct Gpu {
    backend: String,
    name: String,
    #[serde(rename = "vramBytes")]
    vram_bytes: u64,
}

#[derive(Serialize)]
struct HwInfo {
    #[serde(rename = "totalRamBytes")]
    total_ram_bytes: u64,
    #[serde(rename = "availableRamBytes")]
    available_ram_bytes: u64,
    #[serde(rename = "cpuCoresPhysical")]
    cpu_cores_physical: u32,
    gpu: Gpu,
    #[serde(rename = "unifiedMemory")]
    unified_memory: bool,
}

fn physical_cores() -> u32 {
    System::physical_core_count()
        .or_else(|| std::thread::available_parallelism().ok().map(|n| n.get()))
        .unwrap_or(4) as u32
}

/// Run a command and return trimmed stdout, or None on any failure. Used by the
/// GPU probes (non-macOS) and the Apple-Silicon sysctl name lookup.
#[cfg(any(not(target_os = "macos"), target_arch = "aarch64"))]
fn run(cmd: &str, args: &[&str]) -> Option<String> {
    let out = Command::new(cmd).args(args).output().ok()?;
    if !out.status.success() {
        return None;
    }
    Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// NVIDIA: `nvidia-smi --query-gpu=memory.total,name --format=csv,noheader,nounits`
/// prints e.g. "24576, NVIDIA GeForce RTX 4090" (memory in MiB).
#[cfg(not(target_os = "macos"))]
fn probe_nvidia() -> Option<Gpu> {
    let out = run(
        "nvidia-smi",
        &[
            "--query-gpu=memory.total,name",
            "--format=csv,noheader,nounits",
        ],
    )?;
    let line = out.lines().next()?;
    let (mib, name) = line.split_once(',')?;
    let mib: u64 = mib.trim().parse().ok()?;
    Some(Gpu {
        backend: "cuda".into(),
        name: name.trim().to_string(),
        vram_bytes: mib * 1024 * 1024,
    })
}

/// AMD ROCm: parse total VRAM (bytes) from `rocm-smi --showmeminfo vram --csv`.
#[cfg(not(target_os = "macos"))]
fn probe_rocm() -> Option<Gpu> {
    let out = run("rocm-smi", &["--showmeminfo", "vram", "--csv"])?;
    // CSV has a header then a per-GPU row; find the largest integer that looks
    // like a byte count (total VRAM column).
    let vram = out
        .lines()
        .skip(1)
        .flat_map(|l| l.split(','))
        .filter_map(|c| c.trim().parse::<u64>().ok())
        .max()?;
    if vram == 0 {
        return None;
    }
    Some(Gpu {
        backend: "rocm".into(),
        name: "AMD GPU".into(),
        vram_bytes: vram,
    })
}

/// Vulkan: detect any Vulkan-capable discrete/integrated GPU the vendor probes
/// missed (notably Intel Arc/iGPUs). Loads the system Vulkan loader at runtime;
/// returns None cleanly when it is absent (no GPU / no driver) so we fall back
/// to CPU. Picks the first non-CPU physical device and reports its largest
/// DEVICE_LOCAL memory heap as VRAM.
#[cfg(not(target_os = "macos"))]
fn probe_vulkan() -> Option<Gpu> {
    use ash::vk;
    use std::ffi::CStr;

    let entry = unsafe { ash::Entry::load() }.ok()?;
    let app_info = vk::ApplicationInfo::default().api_version(vk::API_VERSION_1_0);
    let create_info = vk::InstanceCreateInfo::default().application_info(&app_info);
    let instance = unsafe { entry.create_instance(&create_info, None) }.ok()?;

    let result = (|| {
        let devices = unsafe { instance.enumerate_physical_devices() }.ok()?;
        for pd in devices {
            let props = unsafe { instance.get_physical_device_properties(pd) };
            if props.device_type == vk::PhysicalDeviceType::CPU {
                continue;
            }
            let mem = unsafe { instance.get_physical_device_memory_properties(pd) };
            let vram = mem.memory_heaps[..mem.memory_heap_count as usize]
                .iter()
                .filter(|h| h.flags.contains(vk::MemoryHeapFlags::DEVICE_LOCAL))
                .map(|h| h.size)
                .max()
                .unwrap_or(0);
            let name = unsafe { CStr::from_ptr(props.device_name.as_ptr()) }
                .to_string_lossy()
                .into_owned();
            return Some(Gpu {
                backend: "vulkan".into(),
                name,
                vram_bytes: vram,
            });
        }
        None
    })();

    unsafe { instance.destroy_instance(None) };
    result
}

// Apple Silicon: GPU shares system RAM (unified). Metal is always present.
#[cfg(all(target_os = "macos", target_arch = "aarch64"))]
fn detect_gpu(total_ram_bytes: u64) -> (Gpu, bool) {
    let name = run("sysctl", &["-n", "machdep.cpu.brand_string"])
        .unwrap_or_else(|| "Apple Silicon".into());
    (
        Gpu {
            backend: "metal".into(),
            name,
            vram_bytes: total_ram_bytes,
        },
        true,
    )
}

// Intel Mac: Metal is available but VRAM is not unified; leave it 0.
#[cfg(all(target_os = "macos", not(target_arch = "aarch64")))]
fn detect_gpu(_total_ram_bytes: u64) -> (Gpu, bool) {
    (
        Gpu {
            backend: "metal".into(),
            name: "Mac GPU".into(),
            vram_bytes: 0,
        },
        false,
    )
}

#[cfg(not(target_os = "macos"))]
fn detect_gpu(_total_ram_bytes: u64) -> (Gpu, bool) {
    // Vendor probes first (they carry accurate VRAM + drive cuda/rocm variant
    // selection); Vulkan catches everything else with a GPU (e.g. Intel).
    probe_nvidia()
        .or_else(probe_rocm)
        .or_else(probe_vulkan)
        .map(|g| (g, false))
        .unwrap_or_else(|| {
            (
                Gpu {
                    backend: "cpu".into(),
                    name: "CPU".into(),
                    vram_bytes: 0,
                },
                false,
            )
        })
}

fn main() {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_all();
    let total_ram_bytes = sys.total_memory();
    let available_ram_bytes = sys.available_memory();

    let (gpu, unified_memory) = detect_gpu(total_ram_bytes);

    let info = HwInfo {
        total_ram_bytes,
        available_ram_bytes,
        cpu_cores_physical: physical_cores(),
        gpu,
        unified_memory,
    };

    match serde_json::to_string(&info) {
        Ok(json) => println!("{json}"),
        Err(_) => println!("{{}}"),
    }
}

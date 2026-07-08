# tomat-client installer for Windows.
#
# Detects the host triple, fetches client.json from the storage origin,
# picks the per-user NSIS installer (.exe) for x86_64-pc-windows-msvc (or
# aarch64), downloads it to %TEMP%, verifies its sha256 against the manifest,
# strips the Mark of the Web (MOTW) attribute so SmartScreen doesn't show the
# "Windows protected your PC" warning, then runs it silently. The NSIS bundle is
# built currentUser (installMode in tauri.conf.json), so it installs under
# %LOCALAPPDATA% with NO administrator prompt.
#
# Trust model (read before pinning a vendor signing key here):
#   1. The installer is fetched over TLS from $env:TOMAT_STORAGE
#      (get.au.tomat.ing by default). Connection-level integrity is HTTPS.
#   2. The manifest at $env:TOMAT_STORAGE/manifests/client.json carries a
#      detached Ed25519 signature (client.json.sig) that is verified against the
#      committed signing key BEFORE any URL or sha256 in it is trusted, exactly
#      like the Unix installer (client.sh). PowerShell/.NET ships no Ed25519
#      primitive, so the verifier is implemented in-script over [bigint] (see the
#      "signature verification" region below); it fails closed on a
#      tampered/unsigned manifest. A MITM that rewrites both the manifest and the
#      binary on the TLS origin no longer installs, because the forged manifest
#      cannot carry a valid signature under the committed key.
#   3. The installer is NOT Authenticode-signed (tomat has no Windows
#      code-signing certificate yet); the currentUser NSIS package avoids the
#      "unknown publisher" elevation prompt a per-machine install would trigger,
#      since it needs no admin rights at all.
#   4. As defense in depth the downloaded .exe's sha256 is compared against the
#      (now-authenticated) manifest value, so a corrupt or truncated download is
#      also rejected.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/client.ps1 | iex"
#
# Env overrides:
#   $env:TOMAT_STORAGE  override storage base URL (default: https://get.au.tomat.ing)
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*] (no spinner on Windows), and rows settle into [x] (done),
#   [~] (no-op skip), or [!] (error). Glyphs upgrade to checkmark/cross on
#   Windows 10 1809+ and Windows 11 (UTF-8 capable conhost / Terminal).

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (the `powershell.exe` this one-liner runs under) redraws
# the Invoke-WebRequest progress bar on every socket read, throttling -OutFile
# downloads to a fraction of the link speed. Suppressing progress restores full
# throughput on the multi-tens-of-MB NSIS installer.
$ProgressPreference = "SilentlyContinue"

# ===== UI helpers begin =====
# Self-contained UI helper block. Keep this region intact so future install
# scripts can copy it verbatim. No external state, no shared library --
# everything below operates on $script: variables only.

# --- UI state -------------------------------------------------------------

$script:UiTty         = -not [Console]::IsOutputRedirected
$script:UiRowsTotal   = 0
$script:UiCurrent     = -1
$script:UiTopRow      = 0
$script:UiLabels      = @()
$script:UiCurrentLabel = ""
$script:UiCurrentSuffix = ""
$script:UiStagingPaths = New-Object System.Collections.ArrayList
$script:UiCleanupInstalled = $false

# Glyphs. ASCII baseline; upgrade to unicode on Windows 10 1809+ which
# defaults to a UTF-8 capable conhost. We always attempt unicode -- if the
# host can't render it the layout stays intact, just with substitute glyphs.
$script:UiGlyphPend  = " "
$script:UiGlyphDoing = "*"
$script:UiGlyphDone  = [char]0x2713  # checkmark
$script:UiGlyphSkip  = "~"
$script:UiGlyphErr   = [char]0x2717  # cross

# --- low-level row rendering ---------------------------------------------

function _Ui-FormatRow($glyph, $label, $suffix) {
  if ($suffix) {
    return "  [$glyph] $label $suffix"
  } else {
    return "  [$glyph] $label"
  }
}

# Emit a row in non-TTY mode (one line per state transition).
function _Ui-EmitRow($glyph, $color, $label, $suffix) {
  $text = _Ui-FormatRow $glyph $label $suffix
  if ($color) {
    Write-Host $text -ForegroundColor $color
  } else {
    Write-Host $text
  }
}

# Repaint row $idx in-place. TTY only -- caller must check $script:UiTty.
# The glyph/label/suffix get printed; the dim suffix uses DarkGray.
function _Ui-RepaintRow($idx, $glyph, $color, $label, $suffix) {
  $y = $script:UiTopRow + $idx
  try {
    [Console]::SetCursorPosition(0, $y)
  } catch {
    # Window resized below us, etc. -- fall back to a fresh line.
    _Ui-EmitRow $glyph $color $label $suffix
    return
  }
  # Erase the line first by writing spaces over it, then rewind.
  $width = [Console]::WindowWidth
  if ($width -lt 1) { $width = 80 }
  [Console]::Write((" " * ($width - 1)))
  [Console]::SetCursorPosition(0, $y)
  # Now write the actual row contents.
  Write-Host "  [" -NoNewline
  if ($color) {
    Write-Host $glyph -NoNewline -ForegroundColor $color
  } else {
    Write-Host $glyph -NoNewline
  }
  Write-Host "] $label" -NoNewline
  if ($suffix) {
    Write-Host " $suffix" -NoNewline -ForegroundColor DarkGray
  }
  # Park the cursor below the last row so subsequent Write-Host appends in
  # the right place if the UI block is followed by plain output.
  $tail = $script:UiTopRow + $script:UiRowsTotal
  try { [Console]::SetCursorPosition(0, $tail) } catch { }
}

# --- staging cleanup -----------------------------------------------------

function _Ui-TrackStaging($p) {
  [void]$script:UiStagingPaths.Add($p)
}

function _Ui-CleanupStaging {
  foreach ($p in $script:UiStagingPaths) {
    if (Test-Path $p) {
      Remove-Item -Force $p -ErrorAction SilentlyContinue
    }
  }
  $script:UiStagingPaths.Clear()
}

function _Ui-Cleanup {
  _Ui-CleanupStaging
  if ($script:UiTty) {
    try { [Console]::CursorVisible = $true } catch { }
  }
}

# --- public surface ------------------------------------------------------

# Ui-Init "TITLE" -- emit the title block; hide cursor; save top row.
function Ui-Init($Title) {
  Write-Host ""
  Write-Host "  $Title"
  Write-Host ""
  if ($script:UiTty) {
    try {
      $script:UiTopRow = [Console]::CursorTop
      [Console]::CursorVisible = $false
    } catch {
      # Non-interactive host that pretended to be a TTY -- degrade.
      $script:UiTty = $false
    }
  }
  $script:UiCleanupInstalled = $true
}

# Ui-ActionAdd "LABEL" -- register a pending row; return the row index.
function Ui-ActionAdd($Label) {
  $idx = $script:UiRowsTotal
  $script:UiLabels += $Label
  $script:UiRowsTotal = $script:UiRowsTotal + 1
  $text = _Ui-FormatRow $script:UiGlyphPend $Label $null
  Write-Host $text
  return $idx
}

# Ui-ActionStart -Idx N -Label "LABEL" [-Suffix "(0/3)"]
function Ui-ActionStart($Idx, $Label, $Suffix) {
  $script:UiCurrent = $Idx
  $script:UiCurrentLabel = $Label
  $script:UiCurrentSuffix = $Suffix
  if ($script:UiTty) {
    _Ui-RepaintRow $Idx $script:UiGlyphDoing $null $Label $Suffix
  } else {
    _Ui-EmitRow $script:UiGlyphDoing $null $Label $Suffix
  }
}

# Ui-ActionUpdate -Idx N -Suffix "(2/3)" -- mutate the in-flight row.
function Ui-ActionUpdate($Idx, $Suffix) {
  $script:UiCurrentSuffix = $Suffix
  if ($script:UiTty) {
    _Ui-RepaintRow $Idx $script:UiGlyphDoing $null $script:UiCurrentLabel $Suffix
  } else {
    _Ui-EmitRow $script:UiGlyphDoing $null $script:UiCurrentLabel $Suffix
  }
}

function _Ui-Finalize($Idx, $Glyph, $Color, $Detail) {
  $label = $script:UiLabels[$Idx]
  if ($script:UiTty) {
    _Ui-RepaintRow $Idx $Glyph $Color $label $Detail
  } else {
    _Ui-EmitRow $Glyph $Color $label $Detail
  }
  $script:UiCurrent = -1
  $script:UiCurrentLabel = ""
  $script:UiCurrentSuffix = ""
}

function Ui-ActionDone($Idx, $Detail) {
  _Ui-Finalize $Idx $script:UiGlyphDone "Green" $Detail
}

function Ui-ActionSkip($Idx, $Detail) {
  _Ui-Finalize $Idx $script:UiGlyphSkip "Green" $Detail
}

function Ui-ActionError($Idx, $Detail) {
  _Ui-Finalize $Idx $script:UiGlyphErr "Red" $Detail
}

# Ui-Finish -Lines @("Pairing code: X", "", "Open ...")
function Ui-Finish($Lines) {
  if ($script:UiTty) {
    try { [Console]::CursorVisible = $true } catch { }
    # Make sure we're below the last row so the footer doesn't overwrite UI.
    try { [Console]::SetCursorPosition(0, $script:UiTopRow + $script:UiRowsTotal) } catch { }
  }
  Write-Host ""
  foreach ($line in $Lines) {
    if (-not $line) {
      Write-Host ""
    } else {
      Write-Host "  $line"
    }
  }
  Write-Host ""
}

# Ui-Die "REASON" ["DETAIL"] ["HINT"]
# Flip current row to [x] (red), print structured error block, exit 1.
function Ui-Die($Reason, $Detail, $Hint) {
  if ($script:UiCurrent -ge 0) {
    _Ui-Finalize $script:UiCurrent $script:UiGlyphErr "Red" $Reason
  }
  if ($script:UiTty) {
    try { [Console]::CursorVisible = $true } catch { }
    try { [Console]::SetCursorPosition(0, $script:UiTopRow + $script:UiRowsTotal) } catch { }
  }
  # Error block on stderr; emit in one stream so colored prefix and message
  # stay ordered. Write-Host -ForegroundColor only colors host (stdout) text,
  # so we use a plain stderr write here.
  [Console]::Error.WriteLine("")
  [Console]::Error.WriteLine("error: $Reason")
  if ($Detail) {
    [Console]::Error.WriteLine("       $Detail")
  }
  if ($Hint) {
    [Console]::Error.WriteLine("hint:  $Hint")
  }
  [Console]::Error.WriteLine("")
  _Ui-Cleanup
  exit 1
}

# ===== UI helpers end =====

# ===== signature verification begin =====
# Self-contained Ed25519 (RFC 8032) verification in pure PowerShell so this
# installer authenticates the release manifest against the SAME committed key the
# Unix installers use (scripts/install/*.sh) BEFORE trusting any URL or sha256
# from it. PowerShell/.NET ships no Ed25519 primitive, so the curve math is
# implemented here over [bigint] (SHA-512 comes from the BCL). Keep this region
# self-contained and identical across core.ps1 / client.ps1 so it can be copied
# verbatim; the per-manifest wiring (embedded vs detached signature) lives in
# each script's install flow, not here.
#
# Fail-closed guardrail: this crypto cannot lean on a battle-tested external
# tool, so Invoke-VerifySelfCheck runs positive + negative Ed25519 and a
# canonical-JSON known-answer test before any real verification. If a porting bug
# makes ANY of them wrong the installer ABORTS. A bug can therefore only ever
# refuse to install, never fail open.

# Committed Ed25519 signing public key (base64 raw key), kept in sync with
# packages/tomat-core/data/signing-keys.json (a test guards the match).
$script:SigningPubkeyB64 = "KghrHOIqu76Hpl/xX8RHUuDA2n1NGCOj9gD1Jrn5H+M="

$script:EdP = [bigint]::Pow(2, 255) - [bigint]19

function _Ed-Mod($a, $m) {
  $r = [bigint]::Remainder($a, $m)
  if ($r -lt [bigint]::Zero) { $r = $r + $m }
  return $r
}
function _Ed-Inv($x) {
  return [bigint]::ModPow((_Ed-Mod $x $script:EdP), ($script:EdP - [bigint]2), $script:EdP)
}
$script:EdD = _Ed-Mod ([bigint](-121665) * (_Ed-Inv ([bigint]121666))) $script:EdP
$script:EdI = [bigint]::ModPow([bigint]2, [bigint]::Divide(($script:EdP - [bigint]1), [bigint]4), $script:EdP)

function _Ed-XRecover($y) {
  $p = $script:EdP
  $xx = _Ed-Mod ((($y * $y) - [bigint]1) * (_Ed-Inv (($script:EdD * $y * $y) + [bigint]1))) $p
  $x = [bigint]::ModPow($xx, [bigint]::Divide(($p + [bigint]3), [bigint]8), $p)
  if ((_Ed-Mod (($x * $x) - $xx) $p) -ne [bigint]::Zero) { $x = _Ed-Mod ($x * $script:EdI) $p }
  if ((_Ed-Mod $x ([bigint]2)) -ne [bigint]::Zero) { $x = $p - $x }
  return $x
}
$script:EdBy = _Ed-Mod ([bigint]4 * (_Ed-Inv ([bigint]5))) $script:EdP
$script:EdBx = _Ed-XRecover $script:EdBy
$script:EdB = @($script:EdBx, $script:EdBy)

function _Ed-Edwards($P, $Q) {
  # $pp, not $p: PowerShell variables are case-insensitive, so a local named $p
  # would alias the point parameter $P and overwrite it with the modulus.
  $pp = $script:EdP
  $x1 = $P[0]; $y1 = $P[1]; $x2 = $Q[0]; $y2 = $Q[1]
  $t = $script:EdD * $x1 * $x2 * $y1 * $y2
  $x3 = (($x1 * $y2) + ($x2 * $y1)) * (_Ed-Inv ([bigint]1 + $t))
  $y3 = (($y1 * $y2) + ($x1 * $x2)) * (_Ed-Inv ([bigint]1 - $t))
  return ,@((_Ed-Mod $x3 $pp), (_Ed-Mod $y3 $pp))
}
function _Ed-ScalarMult($P, $e) {
  $Q = @([bigint]::Zero, [bigint]::One)
  if ($e -le [bigint]::Zero) { return ,$Q }
  $bits = New-Object System.Collections.Generic.List[int]
  $n = $e
  while ($n -gt [bigint]::Zero) {
    $bits.Add([int](_Ed-Mod $n ([bigint]2)))
    $n = [bigint]::Divide($n, [bigint]2)
  }
  for ($i = $bits.Count - 1; $i -ge 0; $i--) {
    $Q = _Ed-Edwards $Q $Q
    if ($bits[$i] -eq 1) { $Q = _Ed-Edwards $Q $P }
  }
  return ,$Q
}
function _Ed-DecodeIntLE([byte[]]$bytes) {
  # Unsigned little-endian -> bigint (append a 0x00 high byte to force positive).
  $tmp = New-Object byte[] ($bytes.Length + 1)
  [Array]::Copy($bytes, $tmp, $bytes.Length)
  return [System.Numerics.BigInteger]::new($tmp)
}
function _Ed-IsOnCurve($P) {
  # $pp, not $p: PowerShell is case-insensitive, so $p would alias the param $P.
  $pp = $script:EdP
  $x = $P[0]; $y = $P[1]
  $v = _Ed-Mod (((-($x * $x)) + ($y * $y)) - [bigint]1 - ($script:EdD * $x * $x * $y * $y)) $pp
  return ($v -eq [bigint]::Zero)
}
function _Ed-DecodePoint([byte[]]$bytes) {
  $num = _Ed-DecodeIntLE $bytes
  $two255 = [bigint]::Pow(2, 255)
  $y = _Ed-Mod $num $two255
  $signBit = _Ed-Mod ([bigint]::Divide($num, $two255)) ([bigint]2)
  $x = _Ed-XRecover $y
  if ((_Ed-Mod $x ([bigint]2)) -ne $signBit) { $x = $script:EdP - $x }
  $P = @($x, $y)
  if (-not (_Ed-IsOnCurve $P)) { throw "point off curve" }
  return ,$P
}
function _Ed-Hint([byte[]]$bytes) {
  $sha = [System.Security.Cryptography.SHA512]::Create()
  try { $h = $sha.ComputeHash($bytes) } finally { $sha.Dispose() }
  return _Ed-DecodeIntLE $h
}
function Test-Ed25519([byte[]]$msg, [byte[]]$sig, [byte[]]$pub) {
  try {
    if ($null -eq $sig -or $sig.Length -ne 64) { return $false }
    if ($null -eq $pub -or $pub.Length -ne 32) { return $false }
    $rBytes = New-Object byte[] 32; [Array]::Copy($sig, 0, $rBytes, 0, 32)
    $sBytes = New-Object byte[] 32; [Array]::Copy($sig, 32, $sBytes, 0, 32)
    $R = _Ed-DecodePoint $rBytes
    $A = _Ed-DecodePoint $pub
    $S = _Ed-DecodeIntLE $sBytes
    $m = if ($null -eq $msg) { New-Object byte[] 0 } else { $msg }
    $hIn = New-Object byte[] (64 + $m.Length)
    [Array]::Copy($rBytes, 0, $hIn, 0, 32)
    [Array]::Copy($pub, 0, $hIn, 32, 32)
    if ($m.Length -gt 0) { [Array]::Copy($m, 0, $hIn, 64, $m.Length) }
    $h = _Ed-Hint $hIn
    $left = _Ed-ScalarMult $script:EdB $S
    $right = _Ed-Edwards $R (_Ed-ScalarMult $A $h)
    return (($left[0] -eq $right[0]) -and ($left[1] -eq $right[1]))
  } catch {
    return $false
  }
}

function _Json-EscapeString([string]$s) {
  # Match JSON.stringify string escaping (the basis of canonicalize): escape " and
  # \, the C0 short forms, other <0x20 as \uXXXX; leave >=0x20 (incl. '/') as-is.
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append([char]0x22)
  foreach ($ch in $s.ToCharArray()) {
    $code = [int][char]$ch
    if ($ch -eq [char]0x22) { [void]$sb.Append('\"') }
    elseif ($ch -eq [char]0x5C) { [void]$sb.Append('\\') }
    elseif ($code -eq 8) { [void]$sb.Append('\b') }
    elseif ($code -eq 12) { [void]$sb.Append('\f') }
    elseif ($code -eq 10) { [void]$sb.Append('\n') }
    elseif ($code -eq 13) { [void]$sb.Append('\r') }
    elseif ($code -eq 9) { [void]$sb.Append('\t') }
    elseif ($code -lt 0x20) { [void]$sb.Append('\u'); [void]$sb.Append($code.ToString('x4')) }
    else { [void]$sb.Append($ch) }
  }
  [void]$sb.Append([char]0x22)
  return $sb.ToString()
}
function ConvertTo-CanonicalJson($v) {
  # Reproduce @tomat/shared canonicalize(): object keys sorted (ordinal, matching
  # JS String.sort over ASCII keys), arrays in order, no insignificant whitespace.
  if ($null -eq $v) { return 'null' }
  if ($v -is [bool]) { if ($v) { return 'true' } else { return 'false' } }
  if ($v -is [string]) { return (_Json-EscapeString $v) }
  if ($v -is [int] -or $v -is [long] -or $v -is [double] -or $v -is [decimal] -or $v -is [single] -or $v -is [bigint]) {
    return $v.ToString([System.Globalization.CultureInfo]::InvariantCulture)
  }
  if ($v -is [System.Management.Automation.PSCustomObject]) {
    $names = @($v.PSObject.Properties | ForEach-Object { $_.Name })
    [Array]::Sort($names, [System.StringComparer]::Ordinal)
    $parts = foreach ($n in $names) { (_Json-EscapeString $n) + ':' + (ConvertTo-CanonicalJson ($v.$n)) }
    return '{' + ($parts -join ',') + '}'
  }
  if ($v -is [System.Collections.IEnumerable]) {
    $parts = foreach ($e in $v) { ConvertTo-CanonicalJson $e }
    return '[' + ($parts -join ',') + ']'
  }
  return (_Json-EscapeString ([string]$v))
}

function _Hex-ToBytes([string]$hex) {
  $n = [int]($hex.Length / 2)
  $b = New-Object byte[] $n
  for ($i = 0; $i -lt $n; $i++) { $b[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
  return ,$b
}
# Positive + negative Ed25519 and a canonical-JSON known-answer test. Returns
# $true only when the in-script crypto both accepts a valid signature and rejects
# a tampered one AND reproduces canonicalize() byte-for-byte. Callers MUST abort
# when this returns $false: a porting bug then fails the install closed instead of
# trusting an unverified manifest. Vectors are generated by scripts/install/verify.test.ts.
function Invoke-VerifySelfCheck {
  try {
    $pub = _Hex-ToBytes "755c4cb9256ca7cdc4acfdc6cfeeda849017e5b9f9514e99191bd67e0b0d4276"
    $msg = [System.Text.Encoding]::ASCII.GetBytes("tomat-ed25519-known-answer-test")
    $sig = _Hex-ToBytes "7b289d6ab9d3cb4cab6a03ba838f4265ffe50bf547feefbf5509308b8285a301e608bdb8480db3a468ce91d0442a4292bc31ef4f16925b1f41446cf9b0c17e0c"
    if (-not (Test-Ed25519 $msg $sig $pub)) { return $false }
    $bad = $sig.Clone(); $bad[0] = [byte]($bad[0] -bxor 1)
    if (Test-Ed25519 $msg $bad $pub) { return $false }
    $obj = ('{"b":[2,1],"a":"x/y","n":1,"s":"a\"b\\c"}' | ConvertFrom-Json)
    if ((ConvertTo-CanonicalJson $obj) -ne '{"a":"x/y","b":[2,1],"n":1,"s":"a\"b\\c"}') { return $false }
    return $true
  } catch {
    return $false
  }
}
# ===== signature verification end =====

# --- offline self-test (exercised by scripts/install/verify.test.ts) ------
# Mirrors client.sh: when TOMAT_SELFTEST is set, verify a LOCAL manifest against
# a detached base64 signature with the exact Ed25519 + sha256 path the install
# flow uses, then exit before any network/install. The client manifest signature
# is DETACHED (over the raw manifest bytes). TOMAT_SELFTEST_PUBKEY_B64 overrides
# the committed key so the test can sign fixtures with an ephemeral keypair.
if ($env:TOMAT_SELFTEST) {
  if ($env:TOMAT_SELFTEST_PUBKEY_B64) { $script:SigningPubkeyB64 = $env:TOMAT_SELFTEST_PUBKEY_B64 }
  if (-not (Invoke-VerifySelfCheck)) { [Console]::Error.WriteLine("selftest: self-check FAILED"); exit 1 }
  $ok = $false
  try {
    $manifestBytes = [System.IO.File]::ReadAllBytes($env:TOMAT_SELFTEST_MANIFEST)
    $sigB64 = (Get-Content -Raw -Path $env:TOMAT_SELFTEST_SIG_B64).Trim()
    $sig = [Convert]::FromBase64String($sigB64)
    $pub = [Convert]::FromBase64String($script:SigningPubkeyB64)
    $ok = Test-Ed25519 $manifestBytes $sig $pub
  } catch { $ok = $false }
  if (-not $ok) { [Console]::Error.WriteLine("selftest: signature INVALID"); exit 1 }
  if ($env:TOMAT_SELFTEST_ARTIFACT) {
    $got = (Get-FileHash -Algorithm SHA256 -Path $env:TOMAT_SELFTEST_ARTIFACT).Hash.ToLower()
    if ($got -ne ([string]$env:TOMAT_SELFTEST_SHA).ToLower()) { [Console]::Error.WriteLine("selftest: sha256 MISMATCH"); exit 1 }
  }
  Write-Output "selftest: OK"
  exit 0
}

# --- configuration --------------------------------------------------------

$Storage = if ($env:TOMAT_STORAGE) { $env:TOMAT_STORAGE } else { "https://get.au.tomat.ing" }
# Install channel via TOMAT_CHANNEL env. A latest client is a distinct app
# ("tomat (latest)", identifier au.tomat.ing.latest) that coexists with stable
# and updates from the latest manifest. The NSIS installer itself controls the
# install dir + product name (baked by build-client.ts); this script just picks
# the channel manifest + display strings.
$Channel = if ($env:TOMAT_CHANNEL) { $env:TOMAT_CHANNEL } else { "stable" }
if ($Channel -notin @("stable", "dev", "latest")) {
  Write-Error "invalid TOMAT_CHANNEL: $Channel (expected stable, dev, or latest)"
  exit 1
}
if ($Channel -eq "stable") {
  $ManifestDir = "manifests"
  $DisplayName = "tomat"
  $InstallDirName = "tomat"
} else {
  $ManifestDir = "manifests/$Channel"
  $DisplayName = if ($Channel -eq "latest") { "tomat (latest)" } else { "tomat (dev)" }
  $InstallDirName = "tomat-$Channel"
}
$ManifestUrl = "$Storage/$ManifestDir/client.json"

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat-client installer"

  $IdxHost     = Ui-ActionAdd "Detecting host"
  $IdxDownload = Ui-ActionAdd "Downloading installer to %TEMP%"
  $IdxVerify   = Ui-ActionAdd "Verifying download (sha256)"
  $IdxMotw     = Ui-ActionAdd "Clearing Mark of the Web"
  $IdxInstall  = Ui-ActionAdd "Installing $DisplayName (per-user, no admin prompt)"

  # --- action 1: detect host ----------------------------------------------

  Ui-ActionStart $IdxHost "Detecting host"

  if (-not [Environment]::Is64BitOperatingSystem) {
    Ui-Die "Unsupported OS" `
      "32-bit Windows is not supported" `
      "tomat targets 64-bit Windows"
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
  $Triple = "$arch-pc-windows-msvc"
  # client.json is the Tauri updater endpoint, so its `platforms` map is keyed in
  # Tauri's `<os>-<arch>` format (windows-x86_64, windows-aarch64), NOT the Rust
  # triple. Match tauriPlatformKey() in scripts/release/client.ts.
  $PlatformKey = "windows-$arch"

  Ui-ActionDone $IdxHost "($Triple)"

  # --- action 2: download installer ---------------------------------------

  Ui-ActionStart $IdxDownload "Downloading installer to %TEMP%" "(fetching manifest)"

  $manifest = $null
  try {
    $resp = Invoke-WebRequest -Uri $ManifestUrl -UseBasicParsing
    if (-not $resp.Content) {
      Ui-Die "Empty manifest from $ManifestUrl" `
        "" `
        "transient outage at R2; try again in a few minutes"
    }
    try {
      $manifest = $resp.Content | ConvertFrom-Json
    } catch {
      Ui-Die "Could not parse manifest JSON" `
        "" `
        "redirected or proxy interception?"
    }
  } catch {
    $status = 0
    try {
      if ($_.Exception.Response) {
        $status = [int]$_.Exception.Response.StatusCode
      }
    } catch { }
    if ($status -eq 404) {
      Ui-Die "Manifest not found at $ManifestUrl" `
        "HTTP 404" `
        "the storage origin may be misconfigured; report at github.com/rzkyif/tomat/issues"
    } elseif ($status -ge 500 -and $status -lt 600) {
      Ui-Die "Storage returned $status" `
        "" `
        "transient outage at R2; try again in a few minutes"
    } else {
      Ui-Die "Network error reaching get.au.tomat.ing" `
        $_.Exception.Message `
        "check internet connectivity, then re-run"
    }
  }

  # Authenticate the manifest before trusting any URL/sha256 in it (matches
  # client.sh). The detached signature (client.json.sig) covers the raw manifest
  # bytes; a tampered or unsigned manifest fails closed here.
  $SigUrl = "$Storage/$ManifestDir/client.json.sig"
  $sigB64 = $null
  try {
    $sigResp = Invoke-WebRequest -Uri $SigUrl -UseBasicParsing
    $sigB64 = ([string]$sigResp.Content).Trim()
  } catch {
    Ui-Die "Manifest signature not found" `
      "GET $SigUrl failed: $($_.Exception.Message)" `
      "the storage origin may be misconfigured; report at github.com/rzkyif/tomat/issues"
  }
  if (-not (Invoke-VerifySelfCheck)) {
    Ui-Die "Signature self-check failed" `
      "the installer's built-in verifier did not pass its known-answer test on this host" `
      "report at github.com/rzkyif/tomat/issues"
  }
  $sigOk = $false
  try {
    $manifestBytes = [System.Text.Encoding]::UTF8.GetBytes([string]$resp.Content)
    $sigBytes = [Convert]::FromBase64String($sigB64)
    $pubBytes = [Convert]::FromBase64String($script:SigningPubkeyB64)
    $sigOk = Test-Ed25519 $manifestBytes $sigBytes $pubBytes
  } catch { $sigOk = $false }
  if (-not $sigOk) {
    Ui-Die "Manifest signature verification failed" `
      "" `
      "the manifest may have been tampered with in transit; aborting"
  }

  if (-not $manifest.version) {
    Ui-Die "Manifest missing version field" `
      "" `
      "the storage origin may be misconfigured"
  }
  $entry = $manifest.platforms.$PlatformKey
  if (-not $entry -or -not $entry.url) {
    Ui-Die "No client artifact for $PlatformKey in manifest" `
      "" `
      "your platform may not be supported yet"
  }

  # Stable, friendly filename (not a random temp name): this is what any
  # SmartScreen / antivirus prompt shows the user, so it should read as tomat's.
  $Tmp = Join-Path $env:TEMP "$InstallDirName-setup.exe"
  _Ui-TrackStaging $Tmp

  Ui-ActionUpdate $IdxDownload "(downloading v$($manifest.version))"

  try {
    Invoke-WebRequest -Uri $entry.url -OutFile $Tmp -UseBasicParsing
  } catch {
    Ui-Die "Download interrupted" `
      "Invoke-WebRequest failed for $($entry.url): $($_.Exception.Message)" `
      "re-run; partial files were cleaned up"
  }

  $sizeMb = [int]((Get-Item $Tmp).Length / 1MB)
  Ui-ActionDone $IdxDownload "($sizeMb MB)"

  # --- action 3: verify sha256 -------------------------------------------

  # Matches client.sh: reject a corrupt or truncated download before running it.
  # The manifest was already Ed25519-verified above, so this sha256 (from the
  # authenticated manifest) is defense in depth against a corrupt transfer.
  if (-not $entry.sha256) {
    Ui-ActionSkip $IdxVerify "(no sha256 in manifest)"
  } else {
    Ui-ActionStart $IdxVerify "Verifying download (sha256)"
    $actualSha = (Get-FileHash -Path $Tmp -Algorithm SHA256).Hash.ToLower()
    if ($actualSha -ne $entry.sha256.ToLower()) {
      Ui-Die "Downloaded installer failed sha256 verification" `
        "expected $($entry.sha256), got $actualSha" `
        "the download may be corrupt or tampered; re-run"
    }
    Ui-ActionDone $IdxVerify "(ok)"
  }

  # --- action 4: clear Mark of the Web -----------------------------------

  $motwPresent = $null -ne (Get-Item -Path $Tmp -Stream Zone.Identifier -ErrorAction SilentlyContinue)

  if (-not $motwPresent) {
    Ui-ActionSkip $IdxMotw "(no MOTW present)"
  } else {
    Ui-ActionStart $IdxMotw "Clearing Mark of the Web"
    $motwCleared = $true
    try {
      Unblock-File -Path $Tmp -ErrorAction Stop
    } catch {
      $motwCleared = $false
    }
    if ($motwCleared) {
      Ui-ActionDone $IdxMotw "(cleared)"
    } else {
      Ui-ActionDone $IdxMotw "(MOTW could not be cleared)"
    }
  }

  # --- action 5: install via NSIS (silent, per-user) ---------------------

  Ui-ActionStart $IdxInstall "Installing $DisplayName (per-user, no admin prompt)"

  $proc = $null
  try {
    # /S = NSIS silent install. The bundle's currentUser installMode means no
    # elevation is requested; the app lands under %LOCALAPPDATA% with a Start
    # Menu shortcut. Start-Process -Wait blocks until the installer finishes.
    $proc = Start-Process -FilePath $Tmp -ArgumentList "/S" -Wait -PassThru
  } catch {
    Ui-Die "Could not launch the installer" `
      $_.Exception.Message `
      "the download may be blocked by SmartScreen or antivirus; re-run"
  }

  $code = $proc.ExitCode
  if ($code -eq 0) {
    Ui-ActionDone $IdxInstall "(installed)"
  } else {
    Ui-Die "Installer exited with code $code" `
      "" `
      "quit any running tomat and re-run; if it persists, report at github.com/rzkyif/tomat/issues"
  }

  # --- footer ------------------------------------------------------------

  Ui-Finish @(
    "$DisplayName installed.",
    "",
    "Launch from the Start Menu (search for `"$DisplayName`")."
  )

  exit 0
}
finally {
  _Ui-Cleanup
}

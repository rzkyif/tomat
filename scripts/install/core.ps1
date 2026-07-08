# tomat-core installer for Windows.
#
# Detects the host triple, downloads the signed core manifest from the
# storage origin, picks the matching binary, verifies its SHA-256, installs
# it to %USERPROFILE%\.tomat\<channel>\core\bin\tomat-core.exe, creates the
# admin token + a Task Scheduler entry for auto-start, starts the daemon, and
# prints the initial pairing code.
#
# Trust model (read before pinning a vendor signing key here):
#   1. The installer is fetched over TLS from $env:TOMAT_STORAGE
#      (get.au.tomat.ing by default). Connection-level integrity is HTTPS.
#   2. The manifest at $env:TOMAT_STORAGE/manifests/core.json is also fetched
#      over HTTPS and its Ed25519 signature is verified against the committed
#      signing key BEFORE any URL or sha256 in it is trusted, exactly like the
#      Unix installer (core.sh). PowerShell/.NET ships no Ed25519 primitive, so
#      the verifier is implemented in-script over [bigint] (see the "signature
#      verification" region below); it fails closed on a tampered/unsigned
#      manifest. This closes the first-install MITM window: a compromised TLS
#      chain that serves a malicious manifest + matching binary no longer
#      installs, because the forged manifest cannot carry a valid signature
#      under the committed key.
#   3. The bundled binary is additionally hash-verified (Get-FileHash below)
#      against the (now-authenticated) manifest `sha256` as defense in depth.
#
# Usage (one-liner):
#   powershell -ExecutionPolicy Bypass -Command "iwr -useb https://get.au.tomat.ing/install/core.ps1 | iex"
#
# Env overrides:
#   $env:TOMAT_STORAGE          override storage base URL (default: https://get.au.tomat.ing)
#   $env:TOMAT_CHANNEL          install channel: stable (default) | dev | latest. Selects
#                               the %USERPROFILE%\.tomat\<channel>\core subtree and is
#                               baked into the scheduled task so the daemon matches.
#   $env:TOMAT_CORE_HOME        override install root (default: %USERPROFILE%\.tomat\<channel>\core)
#   $env:TOMAT_INSTALL_SERVICE  "1" (default) registers a Scheduled Task so the
#                               core boots on login. "0" skips it; the client
#                               launches the core on demand via the
#                               `start_local_core` Tauri command.
#   $env:TOMAT_INSTALL_BIND_ALL "1" seeds settings.json with
#                               server.bindHost=0.0.0.0 so the freshly-installed
#                               core listens on all interfaces and other LAN
#                               devices can pair. "0" (default) keeps loopback.
#   $env:TOMAT_INSTALL_BEHIND_PROXY
#                               "1" seeds settings.json with
#                               server.behindProxy=true for a core served
#                               through an HTTPS reverse proxy: clients then
#                               trust the proxy's real certificate when pairing
#                               instead of pinning the core's own. Must be set
#                               before the first pair. "0" (default) pins.
#
# UI:
#   Each phase appears as one row. Pending rows show [ ], the active row
#   shows [*] (no spinner on Windows -- Start-Job overhead is significant;
#   loops mutate the suffix instead), and rows settle into [x] (done),
#   [~] (no-op skip), or [!] (error). Glyphs upgrade to checkmark/cross on
#   Windows 10 1809+ and Windows 11 (UTF-8 capable conhost / Terminal).

$ErrorActionPreference = "Stop"

# Windows PowerShell 5.1 (the `powershell.exe` this one-liner runs under) redraws
# the Invoke-WebRequest progress bar on every socket read, throttling -OutFile
# downloads to a fraction of the link speed. Suppressing progress restores full
# throughput on the multi-tens-of-MB core binary + workers.
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

# Decompress a gzip file ($Src) to ($Dst). Core artifacts (binary, workers,
# helpers) ship gzip-compressed; the manifest sha256 is over the decompressed
# file, which the caller verifies. Uses the BCL GZipStream (no external tool).
function Expand-GzipFile($Src, $Dst) {
  $in = [System.IO.File]::OpenRead($Src)
  try {
    $gz = New-Object System.IO.Compression.GZipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
    try {
      $out = [System.IO.File]::Create($Dst)
      try { $gz.CopyTo($out) } finally { $out.Dispose() }
    } finally { $gz.Dispose() }
  } finally { $in.Dispose() }
}

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
# Mirrors core.sh: when TOMAT_SELFTEST is set, verify a LOCAL manifest with the
# exact canonicalize(minus .signature) + embedded-signature + Ed25519 path the
# install flow uses, then exit before any network/install. The core manifest
# carries an EMBEDDED `signature` field. TOMAT_SELFTEST_PUBKEY_B64 overrides the
# committed key so the test can sign fixtures with an ephemeral keypair.
if ($env:TOMAT_SELFTEST) {
  if ($env:TOMAT_SELFTEST_PUBKEY_B64) { $script:SigningPubkeyB64 = $env:TOMAT_SELFTEST_PUBKEY_B64 }
  if (-not (Invoke-VerifySelfCheck)) { [Console]::Error.WriteLine("selftest: self-check FAILED"); exit 1 }
  $stObj = (Get-Content -Raw -Path $env:TOMAT_SELFTEST_MANIFEST) | ConvertFrom-Json
  $ok = $false
  try {
    $canon = ConvertTo-CanonicalJson ($stObj | Select-Object -Property * -ExcludeProperty signature)
    $payload = [System.Text.Encoding]::UTF8.GetBytes($canon)
    $sig = [Convert]::FromBase64String([string]$stObj.signature)
    $pub = [Convert]::FromBase64String($script:SigningPubkeyB64)
    $ok = Test-Ed25519 $payload $sig $pub
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
# Install channel. Every channel lives under %USERPROFILE%\.tomat\<channel>\
# so dev / latest installs never collide with stable. Validate up front.
$Channel = if ($env:TOMAT_CHANNEL) { $env:TOMAT_CHANNEL } else { "stable" }
if ($Channel -notin @("stable", "dev", "latest")) {
  Write-Error "invalid TOMAT_CHANNEL: $Channel (expected stable, dev, or latest)"
  exit 1
}
# Per-channel naming + port (stable stays bare). Mirrors core.sh + the runtime
# side (paths.ts channelSuffix/corePort + config.ts manifestDir).
if ($Channel -eq "stable") {
  $ChannelSuffix = ""
  $ManifestDir = "manifests"
  $PortOffset = 0
} else {
  $ChannelSuffix = "-$Channel"
  $ManifestDir = "manifests/$Channel"
  $PortOffset = if ($Channel -eq "latest") { 10 } else { 20 }
}
$CorePort = 7800 + $PortOffset
$HomeDir = if ($env:TOMAT_CORE_HOME) { $env:TOMAT_CORE_HOME } else { Join-Path $HOME ".tomat\$Channel\core" }
$BinDir = Join-Path $HomeDir "bin"
$WorkersDir = Join-Path $HomeDir "workers"
$ExtensionsDir = Join-Path $HomeDir "extensions"
$StagingDir = Join-Path $HomeDir "staging"
$LogsDir = Join-Path $HomeDir "logs"
$ManifestUrl = "$Storage/$ManifestDir/core.json"
$InstallService = if ($env:TOMAT_INSTALL_SERVICE) { $env:TOMAT_INSTALL_SERVICE } else { "1" }
$InstallBindAll = if ($env:TOMAT_INSTALL_BIND_ALL) { $env:TOMAT_INSTALL_BIND_ALL } else { "0" }
$InstallBehindProxy = if ($env:TOMAT_INSTALL_BEHIND_PROXY) { $env:TOMAT_INSTALL_BEHIND_PROXY } else { "0" }

# The admin token, settings, Scheduled Task, and process names are all owned by
# the core binary's install-service / mint-code subcommands now, so this script
# no longer derives them (mirrors the cleanup already done in core.sh).
$Installed = Join-Path $BinDir "tomat-core$ChannelSuffix.exe"

# Make sure the staging tree exists before any UI starts.
foreach ($d in @($BinDir, $WorkersDir, $ExtensionsDir, $StagingDir, $LogsDir)) {
  [void](New-Item -ItemType Directory -Force -Path $d)
}

# Service registration (Scheduled Task, or the background fallback) is chosen
# and performed by the core binary's install-service subcommand, so this script
# no longer builds a label or prompts for an admin password (the client sets it
# over the API after pairing; headless installs can set it later).

# --- begin UI -------------------------------------------------------------

try {
  Ui-Init "tomat Core installer"

  # Register every row up front so the cursor knows the total height. The seed
  # binary is fetched + verified here; everything past it is delegated to the
  # core binary's install subcommands.
  #
  # Row labels are user-facing copy in two places at once: this terminal AND
  # the Client's install button, which tails the non-TTY transcript and shows
  # the active row's label with a running percentage (tomat-client
  # .../commands/pairing.rs). Keep them short, plain, and free of paths/URLs;
  # put specifics in the suffix or the stderr progress lines instead.
  $IdxHost     = Ui-ActionAdd "Checking this computer"
  $IdxManifest = Ui-ActionAdd "Finding the newest Core"
  $IdxBin      = Ui-ActionAdd "Downloading the Core"
  $IdxDeps     = Ui-ActionAdd "Installing helpers and workers"
  $IdxService  = Ui-ActionAdd "Starting the Core"
  $IdxPair     = Ui-ActionAdd "Getting a pairing code"

  # --- action 1: detect host ----------------------------------------------

  Ui-ActionStart $IdxHost "Checking this computer"

  if (-not [Environment]::Is64BitOperatingSystem) {
    Ui-Die "Unsupported OS or architecture" `
      "Detected: 32-bit Windows" `
      "tomat targets x86_64/aarch64 on Windows"
  }
  $arch = if ($env:PROCESSOR_ARCHITECTURE -eq "ARM64") { "aarch64" } else { "x86_64" }
  $Triple = "$arch-pc-windows-msvc"

  Ui-ActionDone $IdxHost "($Triple)"

  # --- action 2: fetch manifest -------------------------------------------

  Ui-ActionStart $IdxManifest "Finding the newest Core"

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
    # PS 5.1: System.Net.WebException with .Response.StatusCode
    # PS 7+:  Microsoft.PowerShell.Commands.HttpResponseException with .Response.StatusCode
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
  # core.sh). The embedded signature covers canonicalize(manifest minus
  # .signature); a tampered or unsigned manifest fails closed here.
  if (-not (Invoke-VerifySelfCheck)) {
    Ui-Die "Signature self-check failed" `
      "the installer's built-in verifier did not pass its known-answer test on this host" `
      "report at github.com/rzkyif/tomat/issues"
  }
  if (-not $manifest.signature) {
    Ui-Die "Manifest is not signed" `
      "" `
      "the manifest may have been tampered with in transit; aborting"
  }
  $sigOk = $false
  try {
    $canonBytes = [System.Text.Encoding]::UTF8.GetBytes(
      (ConvertTo-CanonicalJson ($manifest | Select-Object -Property * -ExcludeProperty signature)))
    $sigBytes = [Convert]::FromBase64String([string]$manifest.signature)
    $pubBytes = [Convert]::FromBase64String($script:SigningPubkeyB64)
    $sigOk = Test-Ed25519 $canonBytes $sigBytes $pubBytes
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
  $entry = $manifest.binaries | Where-Object { $_.triple -eq $Triple } | Select-Object -First 1
  if (-not $entry) {
    Ui-Die "No binary for $Triple in manifest" `
      "" `
      "your platform may not be supported yet"
  }

  Ui-ActionDone $IdxManifest "(v$($manifest.version))"

  # --- action 3: install core binary --------------------------------------

  # Pre-check: does the on-disk binary already match?
  $ExistingOk = $false
  if (Test-Path $Installed) {
    try {
      $existingSha = (Get-FileHash -Algorithm SHA256 -Path $Installed).Hash.ToLowerInvariant()
      if ($existingSha -eq $entry.sha256.ToLowerInvariant()) {
        $ExistingOk = $true
      }
    } catch { }
  }

  if ($ExistingOk) {
    Ui-ActionSkip $IdxBin "(already current)"
  } else {
    Ui-ActionStart $IdxBin "Downloading the Core" "(downloading)"

    $BinTmp = Join-Path $StagingDir "tomat-core-$($manifest.version)-$([System.IO.Path]::GetRandomFileName()).exe"
    $BinGz = "$BinTmp.gz"
    _Ui-TrackStaging $BinTmp
    _Ui-TrackStaging $BinGz

    try {
      Invoke-WebRequest -Uri $entry.url -OutFile $BinGz -UseBasicParsing
    } catch {
      Ui-Die "Download interrupted" `
        "Invoke-WebRequest failed for $($entry.url): $($_.Exception.Message)" `
        "re-run; partial files were cleaned up"
    }

    # The artifact ships gzip-compressed; sha256 is over the decompressed binary.
    Ui-ActionUpdate $IdxBin "(decompressing)"
    try {
      Expand-GzipFile $BinGz $BinTmp
    } catch {
      Ui-Die "Could not decompress core binary" `
        "gzip decompress failed: $($_.Exception.Message)" `
        "network corruption is the usual cause; re-run"
    }
    Remove-Item -Force $BinGz -ErrorAction SilentlyContinue

    Ui-ActionUpdate $IdxBin "(verifying)"
    $got = (Get-FileHash -Algorithm SHA256 -Path $BinTmp).Hash.ToLowerInvariant()
    if ($got -ne $entry.sha256.ToLowerInvariant()) {
      Ui-Die "sha256 mismatch on core binary" `
        "want $($entry.sha256), got $got" `
        "network corruption is the usual cause; re-run"
    }

    Ui-ActionUpdate $IdxBin "(installing)"
    try {
      Move-Item -Force $BinTmp $Installed
    } catch [System.UnauthorizedAccessException] {
      Ui-Die "Permission denied writing to $BinDir\" `
        $_.Exception.Message `
        "check ownership of %USERPROFILE%\.tomat"
    } catch {
      Ui-Die "Could not install core binary" `
        "Move-Item failed: $($_.Exception.Message)" `
        "check disk space and ownership of $BinDir\"
    }

    $sizeMb = [int]((Get-Item $Installed).Length / 1MB)
    Ui-ActionDone $IdxBin "($sizeMb MB)"
  }

  # --- deps + service + pairing (delegated to the core binary) ------------
  #
  # Everything past the seed binary is the core binary's own responsibility now
  # (packages/tomat-core/src/install): self-install fetches + verifies the
  # workers + helpers, install-service writes the admin token / optional
  # bind-all / built-in extension and registers the Scheduled Task, and
  # mint-code prints the first pairing code as JSON. TOMAT_CHANNEL /
  # TOMAT_INSTALL_SERVICE / TOMAT_INSTALL_BIND_ALL / TOMAT_INSTALL_BEHIND_PROXY
  # flow through the environment.

  # The subcommand calls below are BARE on purpose: no pipeline, no capture, no
  # redirection (the PowerShell mirror of core.sh's plain `>&2`). The core's
  # install subcommands print progress to stderr and keep stdout clean, so a
  # pipe would relay nothing anyway; worse, ANY PowerShell read of the
  # subcommand's stdout hangs the TOMAT_INSTALL_SERVICE=0 path forever. Every
  # spawn hop on Windows passes bInheritHandles, so the detached core that
  # install-service leaves running inherits the pipe's write end, and the
  # read-to-EOF never completes even after the subcommand exits (the client
  # then sits at "Starting the Core (67%)" until its 45-minute cap). A bare
  # call hands the child this script's own stdout/stderr handles (console or
  # file, neither of which blocks on an open inherited copy), and
  # $LASTEXITCODE still reports the subcommand's exit.

  Ui-ActionStart $IdxDeps "Installing helpers and workers"
  $env:TOMAT_CHANNEL = $Channel
  & $Installed self-install
  if ($LASTEXITCODE -ne 0) {
    Ui-Die "Failed to install helpers and workers" "" "re-run; verification output is above"
  }
  Ui-ActionDone $IdxDeps

  Ui-ActionStart $IdxService "Starting the Core"
  $env:TOMAT_INSTALL_SERVICE = $InstallService
  $env:TOMAT_INSTALL_BIND_ALL = $InstallBindAll
  $env:TOMAT_INSTALL_BEHIND_PROXY = $InstallBehindProxy
  & $Installed install-service
  if ($LASTEXITCODE -ne 0) {
    Ui-Die "Failed to start the Core" "" "re-run with TOMAT_INSTALL_SERVICE=0 to launch core without a service"
  }
  Ui-ActionDone $IdxService

  # --- mint the first pairing code ---------------------------------------

  Ui-ActionStart $IdxPair "Getting a pairing code" "(waiting for core)"
  # Capturing stdout here is safe despite the no-pipeline rule above: this pipe
  # is created AFTER the detached core was launched (so the core holds no copy
  # of its write end), and mint-code spawns nothing that outlives it.
  $code = ""
  try {
    $pairJson = & $Installed mint-code 2>$null
    if ($pairJson) {
      $code = ($pairJson | ConvertFrom-Json).code
    }
  } catch { }
  if ($code) {
    Ui-ActionDone $IdxPair
  } else {
    Ui-ActionSkip $IdxPair "(could not mint; see manual instructions below)"
  }

  # --- footer ------------------------------------------------------------

  # The "Pairing code:" line is parsed by the client's install trampoline
  # (tomat-client .../commands/pairing.rs parse_pairing_code); keep the prefix.
  if ($code) {
    Ui-Finish @(
      "Pairing code: $code",
      "",
      "Open a tomat Client, choose to pair with a Core on another computer,",
      "and enter:",
      "  URL : https://127.0.0.1:$CorePort   (or this host's LAN IP)",
      "  Code: $code"
    )
  } else {
    Ui-Finish @(
      "The Core is installed. Get a pairing code with:",
      "  & '$Installed' mint-code"
    )
  }

  exit 0
}
finally {
  _Ui-Cleanup
}

// _cne-inventory.mjs — broad-surface Windows defensive inventory.
// Five packs that map to the "what does a defender actually own"
// surface beyond the package tree:
//
//   Pack A — App inventory          (registry, Appx, winget, choco, scoop, MSI)
//   Pack B — Protocols              (SMB, TLS, NTLM, Kerberos, LLMNR, mDNS,
//                                    NetBIOS, WPAD, WinRM, RDP, IPv6, IPSec,
//                                    DoH, Wi-Fi, PowerShell logging)
//   Pack C — Windows 11 Pro features (optional features + capabilities, HVCI,
//                                    VBS, Credential Guard, Application Guard,
//                                    Smart App Control, ASR, CFA, exploit
//                                    mitigations, WDAC/AppLocker, UAC, WU)
//   Pack D — Persistence surface    (services, scheduled tasks, Run keys,
//                                    startup folders, drivers, browser exts)
//   Pack E — Hardening baselines    (delta vs. CIS / STIG / MS Security
//                                    Baseline; sentinel checks only — full
//                                    compliance is out of scope here)
//
// Each pack returns a plain JSON object with collected data + per-check
// errors. All shell calls are read-only and timeout-bounded.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, platform, tmpdir } from 'node:os';

// Authorization guard: defensive inventory probes (including Kali-tool
// detection) must only run within the Vigil CLI process tree.
if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write(
    '[vigil-cne-inventory] Access denied: VIGIL_SESSION_TOKEN is not set.\n' +
    'This module may only be invoked from within the Vigil CLI.\n'
  );
  process.exit(1);
}

const PS_TIMEOUT_MS = 25_000;
const PS_LONG_TIMEOUT_MS = 90_000;
const TRUNCATE_LIST = 250;

export function probeCneInventory() {
  if (platform() !== 'win32') {
    return { skipped: 'non-windows host', generatedAt: new Date().toISOString() };
  }
  return {
    generatedAt: new Date().toISOString(),
    apps: probeAppInventory(),
    protocols: probeProtocols(),
    features: probeWindowsFeatures(),
    persistence: probePersistenceSurface(),
    advancedPersistence: probeAdvancedPersistence(),
    hardening: probeHardeningBaselines(),
    networkSurface: probeNetworkSurface(),
    identity: probeIdentitySurface(),
    cryptoSecrets: probeCryptoSecrets(),
    virtualization: probeVirtualization(),
    serviceVulns: probeServiceVulns(),
    securityTools: probeSecurityTools(),
    osVulns: probeOsVulnerabilities(),
  };
}

// ─── Pack A — App inventory ───────────────────────────────────────
export function probeAppInventory() {
  const result = { errors: [] };

  // 1. Registry uninstall keys — the canonical place for "installed apps".
  //    Three hives: HKLM 64-bit, HKLM 32-bit (Wow6432Node), HKCU per-user.
  const uninstallExpr = `
    $paths = @(
      'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKLM:\\Software\\Wow6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
      'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
    );
    $items = foreach ($p in $paths) {
      Get-ItemProperty $p -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName } |
        Select-Object DisplayName,DisplayVersion,Publisher,InstallDate,InstallLocation,
                      UninstallString,EstimatedSize,
                      @{N='Hive';E={ if ($_.PSPath -like '*HKEY_CURRENT_USER*') {'HKCU'} elseif ($_.PSPath -like '*Wow6432Node*') {'HKLM-32'} else {'HKLM-64'} }}
    }
    $items | Sort-Object DisplayName -Unique
  `;
  result.registryUninstall = sliceList(jsonPs(uninstallExpr, { timeoutMs: PS_LONG_TIMEOUT_MS, errors: result.errors, tag: 'registry-uninstall' }));

  // 2. Appx / MSIX (modern Store + sideloaded apps). `-AllUsers` needs
  // elevation; current-user enumeration is still meaningful and works
  // without admin.
  result.appx = sliceList(jsonPs(
    `Get-AppxPackage -ErrorAction SilentlyContinue | Select Name,PackageFullName,Publisher,Version,SignatureKind,InstallLocation`,
    { timeoutMs: PS_LONG_TIMEOUT_MS, errors: result.errors, tag: 'appx' }
  ));

  // 3. winget — `--output -` writes to a literal "-" file (not stdout)
  // and winget always streams progress to stdout, so we use a temp
  // file and read it back.
  if (haveExe('winget')) {
    const tmp = mkdtempSync(join(tmpdir(), 'vigil-winget-'));
    const outFile = join(tmp, 'winget.json');
    textPs(`winget export --output "${outFile}" --accept-source-agreements --disable-interactivity *> $null`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors: result.errors, tag: 'winget' });
    if (existsSync(outFile)) {
      try {
        const parsed = JSON.parse(readFileSync(outFile, 'utf8'));
        const sources = parsed?.Sources ?? [];
        const flat = [];
        for (const s of sources) for (const pkg of s.Packages ?? []) flat.push({ source: s.SourceDetails?.Name, ...pkg });
        result.winget = sliceList(flat);
      } catch (e) {
        result.winget = { error: 'winget export parse failed: ' + String(e?.message ?? e).slice(0, 200) };
      }
    } else {
      result.winget = { error: 'winget export produced no file' };
    }
    try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  } else {
    result.winget = { skipped: 'winget not on PATH' };
  }

  // 4. choco
  if (haveExe('choco')) {
    const out = textPs('choco list --local-only --limit-output 2>$null', { timeoutMs: PS_TIMEOUT_MS, errors: result.errors, tag: 'choco' });
    const items = out.split(/\r?\n/).filter(Boolean).map((line) => {
      const [name, version] = line.split('|');
      return { name, version };
    });
    result.choco = sliceList(items);
  } else {
    result.choco = { skipped: 'choco not on PATH' };
  }

  // 5. scoop
  if (haveExe('scoop')) {
    const out = textPs('scoop export 2>$null', { timeoutMs: PS_TIMEOUT_MS, errors: result.errors, tag: 'scoop' });
    try {
      const parsed = JSON.parse(out);
      const apps = parsed.apps ?? [];
      result.scoop = sliceList(apps.map((a) => ({ name: a.Name ?? a.name, version: a.Version ?? a.version, source: a.Source ?? a.source })));
    } catch {
      result.scoop = { error: 'scoop export parse failed', raw: out.slice(0, 300) };
    }
  } else {
    result.scoop = { skipped: 'scoop not on PATH' };
  }

  // 6. MSI products (Win32_Product is slow + can re-run installer self-heal.
  //    Read MSI product cache from registry instead.)
  result.msiProducts = sliceList(jsonPs(`
    Get-ItemProperty 'HKLM:\\Software\\Classes\\Installer\\Products\\*' -ErrorAction SilentlyContinue |
      Select ProductName,@{N='ProductCode';E={Split-Path $_.PSPath -Leaf}}
  `, { timeoutMs: PS_TIMEOUT_MS, errors: result.errors, tag: 'msi-products' }));

  return result;
}

// ─── Pack B — Protocols ───────────────────────────────────────────
export function probeProtocols() {
  const errors = [];
  return {
    errors,
    smb: {
      server: jsonPs('Get-SmbServerConfiguration | Select EnableSMB1Protocol,EnableSMB2Protocol,EncryptData,RejectUnencryptedAccess,RequireSecuritySignature,EnableSecuritySignature,AuditSmb1Access', { errors, tag: 'smb-server' }),
      client: jsonPs('Get-SmbClientConfiguration | Select EnableSecuritySignature,RequireSecuritySignature,EnableInsecureGuestLogons', { errors, tag: 'smb-client' }),
      smb1Feature: textPs(`(Get-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -ErrorAction SilentlyContinue).State`, { errors, tag: 'smb1-feature' }),
    },
    tls: probeTls(errors),
    ntlm: {
      lmCompatibilityLevel: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa', 'LmCompatibilityLevel', errors),
      ntlmMinClientSec:     regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\MSV1_0', 'NtlmMinClientSec', errors),
      ntlmMinServerSec:     regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\MSV1_0', 'NtlmMinServerSec', errors),
      restrictSendingNtlm:  regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\MSV1_0', 'RestrictSendingNTLMTraffic', errors),
    },
    kerberos: {
      supportedEncTypes: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa\\Kerberos\\Parameters', 'SupportedEncryptionTypes', errors),
    },
    llmnr:   regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows NT\\DNSClient', 'EnableMulticast', errors),
    mdns:    regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Dnscache\\Parameters', 'EnableMDNS', errors),
    netbios: jsonPs(`Get-CimInstance Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = TRUE' | Select Description,TcpipNetbiosOptions`, { errors, tag: 'netbios' }),
    wpad:    {
      autoDetect: regGet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'AutoDetect', errors),
      proxyEnable: regGet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyEnable', errors),
    },
    winrm: {
      serviceStatus: textPs('(Get-Service WinRM -ErrorAction SilentlyContinue).Status', { errors, tag: 'winrm-svc' }),
      listeners: jsonPs(`winrm enumerate winrm/config/listener -format:pretty 2>$null | Out-String`, { errors, tag: 'winrm-listeners' }),
      allowBasic: regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WinRM\\Client', 'AllowBasic', errors),
      allowUnencrypted: regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\WinRM\\Client', 'AllowUnencryptedTraffic', errors),
    },
    rdp: {
      fDenyTSConnections: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server', 'fDenyTSConnections', errors),
      userAuthentication: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp', 'UserAuthentication', errors),
      securityLayer:      regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp', 'SecurityLayer', errors),
      minEncryptionLevel: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Terminal Server\\WinStations\\RDP-Tcp', 'MinEncryptionLevel', errors),
    },
    ipv6:    jsonPs(`Get-NetAdapterBinding -ComponentID ms_tcpip6 | Select Name,Enabled`, { errors, tag: 'ipv6' }),
    ipsec: {
      rules:      textPs('(Get-NetIPsecRule -ErrorAction SilentlyContinue | Measure-Object).Count', { errors, tag: 'ipsec-rules' }),
      mainModeSA: textPs('(Get-NetIPsecMainModeSA -ErrorAction SilentlyContinue | Measure-Object).Count', { errors, tag: 'ipsec-mm' }),
    },
    doh:     jsonPs(`Get-DnsClientDohServerAddress -ErrorAction SilentlyContinue | Select ServerAddress,AllowFallbackToUdp,AutoUpgrade,DohTemplate`, { errors, tag: 'doh' }),
    wifi:    probeWifi(errors),
    powershell: {
      versions:               textPs('$PSVersionTable.PSVersion.ToString()', { errors, tag: 'ps-ver' }),
      executionPolicyAll:     jsonPs('Get-ExecutionPolicy -List', { errors, tag: 'ps-policy' }),
      scriptBlockLogging:     regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ScriptBlockLogging', 'EnableScriptBlockLogging', errors),
      moduleLogging:          regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\ModuleLogging', 'EnableModuleLogging', errors),
      transcription:          regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\PowerShell\\Transcription', 'EnableTranscripting', errors),
      pwsh7:                  textPs('try { (& pwsh -NoProfile -Command "$PSVersionTable.PSVersion.ToString()") } catch { "" }', { errors, tag: 'pwsh7' }),
    },
  };
}

function probeTls(errors) {
  const out = {};
  for (const v of ['SSL 2.0', 'SSL 3.0', 'TLS 1.0', 'TLS 1.1', 'TLS 1.2', 'TLS 1.3']) {
    out[v] = {
      clientEnabled:        regGet(`HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\${v}\\Client`, 'Enabled', errors),
      clientDisabledByDefault: regGet(`HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\${v}\\Client`, 'DisabledByDefault', errors),
      serverEnabled:        regGet(`HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\${v}\\Server`, 'Enabled', errors),
      serverDisabledByDefault: regGet(`HKLM:\\SYSTEM\\CurrentControlSet\\Control\\SecurityProviders\\SCHANNEL\\Protocols\\${v}\\Server`, 'DisabledByDefault', errors),
    };
  }
  return out;
}

function probeWifi(errors) {
  const out = textPs('netsh wlan show interfaces 2>$null', { errors, tag: 'wlan-iface' });
  if (!out) return { skipped: 'netsh wlan returned nothing (no Wi-Fi or service stopped)' };
  // Just pluck the headline fields — full parse is overkill.
  const grab = (label) => (out.match(new RegExp(`^\\s*${label}\\s*:\\s*(.+)$`, 'm'))?.[1] ?? '').trim();
  return {
    state:          grab('State'),
    ssid:           grab('SSID'),
    auth:           grab('Authentication'),
    cipher:         grab('Cipher'),
    bssid:          grab('BSSID'),
    signal:         grab('Signal'),
    radioType:      grab('Radio type'),
  };
}

// ─── Pack C — Windows 11 Pro features ─────────────────────────────
export function probeWindowsFeatures() {
  const errors = [];
  return {
    errors,
    optionalFeatures: sliceList(jsonPs(
      `Get-WindowsOptionalFeature -Online | Where-Object { $_.State -eq 'Enabled' } | Select FeatureName,State`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors, tag: 'optional-features' }
    )),
    capabilities: sliceList(jsonPs(
      `Get-WindowsCapability -Online | Where-Object { $_.State -eq 'Installed' } | Select Name`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors, tag: 'capabilities' }
    )),
    hyperV:       textPs(`(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State`, { errors, tag: 'hyperv' }),
    wsl:          textPs(`(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Windows-Subsystem-Linux).State`, { errors, tag: 'wsl' }),
    containers:   textPs(`(Get-WindowsOptionalFeature -Online -FeatureName Containers).State`, { errors, tag: 'containers' }),
    sandbox:      textPs(`(Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM).State`, { errors, tag: 'sandbox' }),
    deviceGuard: jsonPs(
      `Get-CimInstance -ClassName Win32_DeviceGuard -Namespace root\\Microsoft\\Windows\\DeviceGuard | Select SecurityServicesConfigured,SecurityServicesRunning,VirtualizationBasedSecurityStatus,CodeIntegrityPolicyEnforcementStatus`,
      { errors, tag: 'device-guard' }
    ),
    credentialGuard: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\LSA', 'LsaCfgFlags', errors),
    applicationGuard: textPs(`(Get-WindowsOptionalFeature -Online -FeatureName Windows-Defender-ApplicationGuard).State`, { errors, tag: 'wdag' }),
    windowsHello: {
      ngcSvc:   textPs('(Get-Service NgcSvc -ErrorAction SilentlyContinue).Status', { errors, tag: 'ngc' }),
      passportSvc: textPs('(Get-Service PassportSvc -ErrorAction SilentlyContinue).Status', { errors, tag: 'passport' }),
    },
    smartScreen: {
      explorer: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Explorer', 'SmartScreenEnabled', errors),
      edge:     regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Edge', 'SmartScreenEnabled', errors),
    },
    smartAppControl: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy', 'VerifiedAndReputablePolicyState', errors),
    asrRules: jsonPs(
      `$p = Get-MpPreference; for ($i=0; $i -lt $p.AttackSurfaceReductionRules_Ids.Count; $i++) { @{ id = $p.AttackSurfaceReductionRules_Ids[$i]; action = $p.AttackSurfaceReductionRules_Actions[$i] } }`,
      { errors, tag: 'asr-rules' }
    ),
    controlledFolderAccess: jsonPs(
      `Get-MpPreference | Select EnableControlledFolderAccess,ControlledFolderAccessProtectedFolders,ControlledFolderAccessAllowedApplications`,
      { errors, tag: 'cfa' }
    ),
    exploitProtection: jsonPs(
      `Get-ProcessMitigation -System -ErrorAction SilentlyContinue | ConvertTo-Json -Compress -Depth 4 | ConvertFrom-Json | Select DEP,ASLR,CFG,SEHOP,Heap`,
      { errors, tag: 'exploit-protection' }
    ),
    appLocker:    jsonPs(`(Get-AppLockerPolicy -Effective -ErrorAction SilentlyContinue | ConvertTo-Xml).OuterXml | Out-String | %{ if ($_ -match '<RuleCollection') { @{ configured = $true } } else { @{ configured = $false } } }`, { errors, tag: 'applocker' }),
    wdacPolicies: jsonPs(`Get-CIPolicyInfo -ErrorAction SilentlyContinue | Select PolicyID,FriendlyName,VersionString,Enforce,Mode`, { errors, tag: 'wdac' }),
    uac: {
      enableLUA:                    regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'EnableLUA', errors),
      consentPromptBehaviorAdmin:   regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'ConsentPromptBehaviorAdmin', errors),
      promptOnSecureDesktop:        regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'PromptOnSecureDesktop', errors),
      enableInstallerDetection:     regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System', 'EnableInstallerDetection', errors),
    },
    windowsUpdate: {
      branchReadinessLevel: regGet('HKLM:\\SOFTWARE\\Microsoft\\WindowsUpdate\\UX\\Settings', 'BranchReadinessLevel', errors),
      lastInstalled: jsonPs(`Get-HotFix | Sort InstalledOn -Descending | Select -First 10 | Select HotFixID,Description,InstalledOn`, { errors, tag: 'hotfix' }),
      pendingReboot: textPs(`Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'`, { errors, tag: 'reboot' }),
    },
  };
}

// ─── Pack D — Persistence surface ─────────────────────────────────
export function probePersistenceSurface() {
  const errors = [];
  return {
    errors,
    services: sliceList(jsonPs(
      `Get-CimInstance Win32_Service | Where-Object { $_.StartMode -ne 'Disabled' } | Select -First 300 | Select Name,DisplayName,StartMode,State,StartName,PathName | Sort Name`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors, tag: 'services' }
    )),
    scheduledTasks: sliceList(jsonPs(
      `Get-ScheduledTask | Where-Object { $_.State -ne 'Disabled' } | Select-Object -First 200 | ForEach-Object {
        $task = $_
        $actions = ($task.Actions | Select-Object -First 3 | ForEach-Object { @{ execute = $_.Execute; args = $_.Arguments } })
        @{ taskName = $task.TaskName; taskPath = $task.TaskPath; state = $task.State.ToString(); author = $task.Author; actions = $actions }
      }`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors, tag: 'sched-tasks' }
    )),
    startupCommands: sliceList(jsonPs(
      `Get-CimInstance Win32_StartupCommand | Select Name,Command,Location,User`,
      { errors, tag: 'startup-cmds' }
    )),
    runKeys: {
      hklmRun:     jsonPs(`Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue | Select * -ExcludeProperty PS*`, { errors, tag: 'hklm-run' }),
      hklmRunOnce: jsonPs(`Get-ItemProperty 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -ErrorAction SilentlyContinue | Select * -ExcludeProperty PS*`, { errors, tag: 'hklm-runonce' }),
      hkcuRun:     jsonPs(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -ErrorAction SilentlyContinue | Select * -ExcludeProperty PS*`, { errors, tag: 'hkcu-run' }),
      hkcuRunOnce: jsonPs(`Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\RunOnce' -ErrorAction SilentlyContinue | Select * -ExcludeProperty PS*`, { errors, tag: 'hkcu-runonce' }),
    },
    startupFolders: {
      perUser: listStartupFolder(join(homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')),
      allUsers: listStartupFolder('C:\\ProgramData\\Microsoft\\Windows\\Start Menu\\Programs\\Startup'),
    },
    drivers: sliceList(jsonPs(
      `Get-CimInstance Win32_SystemDriver | Where-Object { $_.State -eq 'Running' } | Select -First 200 | Select Name,DisplayName,StartMode,State,PathName,ServiceType | Sort Name`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors, tag: 'drivers' }
    )),
    browserExtensions: probeBrowserExtensions(),
  };
}

function listStartupFolder(dir) {
  if (!existsSync(dir)) return { skipped: 'folder missing' };
  try {
    return readdirSync(dir).map((name) => {
      const full = join(dir, name);
      try {
        const st = statSync(full);
        return { name, sizeBytes: st.size, mtime: st.mtime.toISOString() };
      } catch { return { name, error: 'stat failed' }; }
    });
  } catch (e) {
    return { error: String(e?.message ?? e).slice(0, 200) };
  }
}

function probeBrowserExtensions() {
  const home = homedir();
  const out = {};
  const browsers = [
    { name: 'chrome',  root: join(home, 'AppData', 'Local', 'Google', 'Chrome', 'User Data') },
    { name: 'edge',    root: join(home, 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data') },
    { name: 'brave',   root: join(home, 'AppData', 'Local', 'BraveSoftware', 'Brave-Browser', 'User Data') },
    { name: 'firefox', root: join(home, 'AppData', 'Roaming', 'Mozilla', 'Firefox', 'Profiles') },
  ];
  for (const b of browsers) {
    if (!existsSync(b.root)) { out[b.name] = { installed: false }; continue; }
    const exts = [];
    try {
      const profileDirs = b.name === 'firefox'
        ? readdirSync(b.root)
        : readdirSync(b.root).filter((d) => /^(Default|Profile \d+)$/.test(d));
      for (const prof of profileDirs) {
        const extDir = b.name === 'firefox'
          ? join(b.root, prof, 'extensions')
          : join(b.root, prof, 'Extensions');
        if (!existsSync(extDir)) continue;
        for (const ext of readdirSync(extDir)) {
          exts.push({ profile: prof, id: ext });
        }
      }
      out[b.name] = { installed: true, count: exts.length, extensions: exts.slice(0, 100) };
    } catch (e) {
      out[b.name] = { installed: true, error: String(e?.message ?? e).slice(0, 200) };
    }
  }
  return out;
}

// ─── Pack E — Hardening baselines (sentinel checks) ───────────────
// Full CIS/STIG/Microsoft Security Baseline compliance requires the
// Security Compliance Toolkit. Here we just flag the highest-impact
// deltas a defender would actually care about.
export function probeHardeningBaselines() {
  const errors = [];
  const note = 'Sentinel checks only. Full CIS / DISA STIG / Microsoft Security Baseline compliance requires the Security Compliance Toolkit running GPO comparison against a domain baseline.';

  const proto = probeProtocols();
  const feat = probeWindowsFeatures();
  const checks = [];

  const push = (id, ok, evidence, recommendation) =>
    checks.push({ id, status: ok ? 'pass' : 'fail', evidence, recommendation });

  // CIS 2.3.10 / STIG V-220929 — restrict NTLM
  push('lm-compat-level-min-3',
    Number(proto.ntlm?.lmCompatibilityLevel) >= 3,
    `LmCompatibilityLevel=${proto.ntlm?.lmCompatibilityLevel ?? '(unset)'}`,
    'Set HKLM\\System\\CurrentControlSet\\Control\\Lsa LmCompatibilityLevel >= 3 (NTLMv2 only).');

  // CIS 2.3.7.4 — UAC consent prompt for admins
  push('uac-prompt-on-secure-desktop',
    Number(feat.uac?.promptOnSecureDesktop) === 1,
    `PromptOnSecureDesktop=${feat.uac?.promptOnSecureDesktop ?? '(unset)'}`,
    'Enable Secure Desktop for elevation prompts.');

  // CIS 18.5.20 — SMB1
  push('smb1-disabled',
    proto.smb?.server?.EnableSMB1Protocol === false || proto.smb?.smb1Feature === 'Disabled',
    `EnableSMB1Protocol=${proto.smb?.server?.EnableSMB1Protocol} feature=${proto.smb?.smb1Feature}`,
    'Disable SMB1 entirely: Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol.');

  // CIS 18.9.39.2 — RDP NLA
  push('rdp-nla-required',
    Number(proto.rdp?.userAuthentication) === 1,
    `UserAuthentication=${proto.rdp?.userAuthentication ?? '(unset)'}`,
    'Require Network Level Authentication on RDP.');

  // CIS 18.5.10.2 — LLMNR off
  push('llmnr-disabled',
    Number(proto.llmnr) === 0,
    `EnableMulticast=${proto.llmnr ?? '(unset)'}`,
    'Disable LLMNR via group policy (Computer Config > Admin Templates > Network > DNS Client).');

  // CIS 18.3.3 — TLS 1.0 server off, TLS 1.2 server on
  const tls10ServerOn = Number(proto.tls?.['TLS 1.0']?.serverEnabled) === 1;
  push('tls-1-0-server-disabled',
    !tls10ServerOn,
    `TLS 1.0 server Enabled=${proto.tls?.['TLS 1.0']?.serverEnabled ?? '(unset)'}`,
    'Disable TLS 1.0 server: set SCHANNEL\\Protocols\\TLS 1.0\\Server Enabled=0.');

  // CIS 18.9.20 — Credential Guard
  push('credential-guard-running',
    Array.isArray(feat.deviceGuard?.SecurityServicesRunning) && feat.deviceGuard.SecurityServicesRunning.includes(1),
    `SecurityServicesRunning=${JSON.stringify(feat.deviceGuard?.SecurityServicesRunning)}`,
    'Enable Credential Guard via Device Guard / VBS.');

  // CIS 18.9.16 — PowerShell ScriptBlock logging
  push('powershell-scriptblock-logging',
    Number(proto.powershell?.scriptBlockLogging) === 1,
    `EnableScriptBlockLogging=${proto.powershell?.scriptBlockLogging ?? '(unset)'}`,
    'Enable PowerShell script-block logging via policy.');

  // CIS 18.10.46.5 — SmartScreen for Explorer
  push('smartscreen-explorer-on',
    /^Rule|^Warn|^On$/i.test(String(feat.smartScreen?.explorer ?? '')),
    `Explorer SmartScreenEnabled=${feat.smartScreen?.explorer ?? '(unset)'}`,
    'Configure Explorer SmartScreen to RequireAdmin or Warn.');

  // Custom — WinRM unencrypted
  push('winrm-unencrypted-disallowed',
    Number(proto.winrm?.allowUnencrypted) !== 1,
    `AllowUnencryptedTraffic=${proto.winrm?.allowUnencrypted ?? '(unset)'}`,
    'Set WinRM client AllowUnencryptedTraffic=0 via policy.');

  const passed = checks.filter((c) => c.status === 'pass').length;
  return {
    errors,
    note,
    summary: { total: checks.length, passed, failed: checks.length - passed },
    checks,
  };
}

// ─── Pack F — Network surface depth ────────────────────────────────
function probeNetworkSurface() {
  const errors = [];
  return {
    errors,
    activeConnections: sliceList(jsonPs(
      `Get-NetTCPConnection -State Established | Select LocalAddress,LocalPort,RemoteAddress,RemotePort,OwningProcess,CreationTime | Sort-Object CreationTime -Descending`,
      { timeoutMs: PS_TIMEOUT_MS, errors, tag: 'tcp-established' }
    )),
    listeners: sliceList(jsonPs(
      `Get-NetTCPConnection -State Listen | Select LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort`,
      { errors, tag: 'tcp-listeners' }
    )),
    udpListeners: sliceList(jsonPs(
      `Get-NetUDPEndpoint | Where-Object LocalAddress -ne '0.0.0.0' | Select LocalAddress,LocalPort,OwningProcess | Sort-Object LocalPort`,
      { errors, tag: 'udp' }
    )),
    arpTable: sliceList(jsonPs(
      `Get-NetNeighbor -AddressFamily IPv4 | Where-Object State -ne 'Unreachable' | Select IPAddress,LinkLayerAddress,State,InterfaceAlias`,
      { errors, tag: 'arp' }
    )),
    dnsCache: {
      count: textPs('(Get-DnsClientCache -ErrorAction SilentlyContinue | Measure-Object).Count', { errors, tag: 'dns-cache-count' }),
      sample: sliceList(jsonPs(
        `Get-DnsClientCache -ErrorAction SilentlyContinue | Sort-Object -Property TimeToLive | Select -First 100 | Select Entry,Data,Type,TimeToLive`,
        { errors, tag: 'dns-cache' }
      )),
    },
    routeTable: textPs('route print -4 2>$null | Select-Object -First 200', { errors, tag: 'route' }),
    hostsFile: textPs('Get-Content "$env:SystemRoot\\System32\\drivers\\etc\\hosts" -ErrorAction SilentlyContinue | Where-Object { $_ -notmatch "^\\s*#" -and $_ -match "\\S" } | Select-Object -First 100', { errors, tag: 'hosts' }),
    networkShares: sliceList(jsonPs(
      `Get-SmbShare -ErrorAction SilentlyContinue | Select Name,Path,Description,ShareState,ShareType | Sort-Object Name`,
      { errors, tag: 'smb-shares' }
    )),
    mappedDrives: jsonPs(
      `Get-CimInstance Win32_MappedLogicalDisk | Select DeviceID,ProviderName,SessionID`,
      { errors, tag: 'mapped-drives' }
    ),
    namedPipes: textPs('Get-ChildItem \\\\.\\pipe\\ -ErrorAction SilentlyContinue | Select-Object -First 200 | ForEach-Object { $_.Name }', { errors, tag: 'pipes' }),
    rpcEndpoints: jsonPs(
      `Get-CimInstance Win32_RPCEndpoint -ErrorAction SilentlyContinue | Select Name,Protocol,AuthenticationInformation | Sort-Object Name | Select-Object -First 100`,
      { errors, tag: 'rpc' }
    ),
    proxySettings: {
      systemProxy: regGet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyServer', errors),
      proxyEnable: regGet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'ProxyEnable', errors),
      autoConfigUrl: regGet('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings', 'AutoConfigURL', errors),
    },
  };
}

// ─── Pack G — Advanced persistence surface ─────────────────────────
function probeAdvancedPersistence() {
  const errors = [];
  return {
    errors,
    wmi: {
      eventFilters: jsonPs(
        `Get-CimInstance -Namespace root/Subscription -ClassName __EventFilter -ErrorAction SilentlyContinue | Select Name,Query,QueryLanguage | Sort-Object Name`,
        { errors, tag: 'wmi-filters' }
      ),
      eventConsumers: jsonPs(
        `Get-CimInstance -Namespace root/Subscription -ClassName __EventConsumer -ErrorAction SilentlyContinue | Select Name,CommandLineTemplate`,
        { errors, tag: 'wmi-consumers' }
      ),
      bindings: jsonPs(
        `Get-CimInstance -Namespace root/Subscription -ClassName __FilterToConsumerBinding -ErrorAction SilentlyContinue | Select Filter,Consumer`,
        { errors, tag: 'wmi-bindings' }
      ),
    },
    lsaPackages: {
      packages: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa', 'Security Packages', errors),
      authPkgs: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa', 'Authentication Packages', errors),
      notificationPkgs: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Lsa', 'Notification Packages', errors),
    },
    appInitDlls: {
      appInit: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows', 'AppInit_DLLs', errors),
      loadAppInit: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows', 'LoadAppInit_DLLs', errors),
      requireSigned: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Windows', 'RequireSignedAppInit_DLLs', errors),
    },
    winlogon: {
      shell: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', 'Shell', errors),
      userinit: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', 'Userinit', errors),
      notify: jsonPs(
        `Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\Notify' -ErrorAction SilentlyContinue | Select PSChildName`,
        { errors, tag: 'winlogon-notify' }
      ),
      ginaDll: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', 'GinaDLL', errors),
      taskman: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', 'Taskman', errors),
      vmApplet: regGet('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon', 'VMApplet', errors),
    },
    bootExecute: regGet('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager', 'BootExecute', errors),
    ifeo: {
      entries: jsonPs(
        `Get-ChildItem 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options' -ErrorAction SilentlyContinue | Where-Object { $_.Property -contains 'Debugger' } | Select PSChildName,@{N='Debugger';E={$_.GetValue('Debugger')}}`,
        { errors, tag: 'ifeo' }
      ),
    },
    printMonitors: sliceList(jsonPs(
      `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Print\\Monitors' -ErrorAction SilentlyContinue | Select PSChildName,@{N='Driver';E={$_.GetValue('Driver')}}`,
      { errors, tag: 'print-monitors' }
    )),
    timeProviders: jsonPs(
      `Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services\\W32Time\\TimeProviders' -ErrorAction SilentlyContinue | Select PSChildName,@{N='DllName';E={$_.GetValue('DllName')}}`,
      { errors, tag: 'time-providers' }
    ),
    winsockLsp: textPs('netsh winsock show catalog 2>$null | Select-Object -First 200', { errors, tag: 'winsock' }),
    bitsJobs: jsonPs(
      `Get-BitsTransfer -ErrorAction SilentlyContinue | Select JobId,DisplayName,TransferType,JobState,OwnerAccount,FileCount,BytesTotal | Select-Object -First 200`,
      { errors, tag: 'bits' }
    ),
    accessibilityHijacks: {
      sethc: checkDebugger('sethc.exe', errors),
      utilman: checkDebugger('utilman.exe', errors),
      magnify: checkDebugger('Magnify.exe', errors),
      narrator: checkDebugger('Narrator.exe', errors),
      osk: checkDebugger('osk.exe', errors),
      displayswitch: checkDebugger('DisplaySwitch.exe', errors),
      atBroker: checkDebugger('AtBroker.exe', errors),
    },
    screensaver: {
      scrnsave: regGet('HKCU:\\Control Panel\\Desktop', 'SCRNSAVE.EXE', errors),
      screenSaverSecure: regGet('HKCU:\\Control Panel\\Desktop', 'ScreenSaverIsSecure', errors),
    },
    officeAddins: { skipped: 'expensive registry walk — run with --full-cne to scan' },
    comHijackSurfaces: { skipped: 'expensive probe — run with --full-cne for CLSID hijack scan' },
  };
}

// ─── Pack H — Identity surface ─────────────────────────────────────
function probeIdentitySurface() {
  const errors = [];
  return {
    errors,
    localUsers: sliceList(jsonPs(
      `Get-LocalUser -ErrorAction SilentlyContinue | Select Name,Enabled,PasswordRequired,PasswordLastSet,LastLogon,Description,SID | Sort-Object Name`,
      { timeoutMs: PS_TIMEOUT_MS, errors, tag: 'local-users' }
    )),
    localGroups: sliceList(jsonPs(
      `Get-LocalGroup -ErrorAction SilentlyContinue | Select Name,Description,SID | Sort-Object Name`,
      { errors, tag: 'local-groups' }
    )),
    administratorsMembers: jsonPs(
      `Get-LocalGroupMember -Group 'Administrators' -ErrorAction SilentlyContinue | Select Name,ObjectClass,PrincipalSource`,
      { errors, tag: 'admin-members' }
    ),
    remoteDesktopUsers: jsonPs(
      `Get-LocalGroupMember -Group 'Remote Desktop Users' -ErrorAction SilentlyContinue | Select Name,ObjectClass`,
      { errors, tag: 'rdp-users' }
    ),
    kerberosTickets: jsonPs(
      `klist sessions 2>$null; $sessions = klist tgt 2>$null | Out-String`,
      { errors, tag: 'kerberos-tickets' }
    ),
    userAccountControl: jsonPs(
      `Get-LocalUser -ErrorAction SilentlyContinue | Where-Object Enabled -eq $true | Select Name,@{N='PasswordNotRequired';E={($_.UserAccountControl -band 0x0020) -ne 0}},@{N='PasswordNeverExpires';E={($_.UserAccountControl -band 0x10000) -ne 0}},@{N='DontRequirePreauth';E={($_.UserAccountControl -band 0x40000000) -ne 0}}`,
      { errors, tag: 'uac-flags' }
    ),
  };
}

// ─── Pack I — Crypto & secrets surface ─────────────────────────────
function probeCryptoSecrets() {
  const errors = [];
  const home = homedir();
  return {
    errors,
    certificateStore: {
      personal: sliceList(jsonPs(
        `Get-ChildItem Cert:\\CurrentUser\\My -ErrorAction SilentlyContinue | Select Subject,Issuer,NotAfter,Thumbprint,HasPrivateKey | Sort-Object NotAfter -Descending | Select-Object -First 100`,
        { errors, tag: 'cert-my' }
      )),
      ca: sliceList(jsonPs(
        `Get-ChildItem Cert:\\CurrentUser\\CA -ErrorAction SilentlyContinue | Select Subject,Issuer,NotAfter,Thumbprint | Sort-Object NotAfter -Descending | Select-Object -First 50`,
        { errors, tag: 'cert-ca' }
      )),
    },
    credentialManager: {
      genericCount: textPs("(cmdkey /list 2>$null | Select-String 'Target:' | Measure-Object).Count", { errors, tag: 'cmdkey' }),
      targets: textPs('cmdkey /list 2>$null', { errors, tag: 'cmdkey-list' }),
    },
    dpapiKeys: {
      masterKeyDir: probeDir(join(home, 'AppData', 'Roaming', 'Microsoft', 'Protect'), errors, 'dpapi-master'),
      credHistDir: probeDir(join(home, 'AppData', 'Roaming', 'Microsoft', 'Protect', 'CREDHIST'), errors, 'dpapi-credhist'),
    },
    sshKeys: {
      userSshDir: probeDir(join(home, '.ssh'), errors, 'ssh-user'),
      authorizedKeys: textPs(`Get-Content "${join(home, '.ssh', 'authorized_keys').replace(/\\/g, '\\\\')}" -ErrorAction SilentlyContinue | Select-Object -First 50`, { errors, tag: 'ssh-auth-keys' }),
      knownHosts: textPs(`Get-Content "${join(home, '.ssh', 'known_hosts').replace(/\\/g, '\\\\')}" -ErrorAction SilentlyContinue | Select-Object -First 100`, { errors, tag: 'ssh-known-hosts' }),
      config: textPs(`Get-Content "${join(home, '.ssh', 'config').replace(/\\/g, '\\\\')}" -ErrorAction SilentlyContinue`, { errors, tag: 'ssh-config' }),
    },
    gpgKeys: probeDir(join(home, 'AppData', 'Roaming', 'gnupg'), errors, 'gpg'),
    puttySessions: jsonPs(
      `Get-ChildItem 'HKCU:\\Software\\SimonTatham\\PuTTY\\Sessions' -ErrorAction SilentlyContinue | Select PSChildName`,
      { errors, tag: 'putty' }
    ),
    environmentSecrets: probeEnvSecrets(errors),
  };
}

function probeEnvSecrets(errors) {
  const sensitive = /(?:key|secret|token|password|cred|auth|api|saas|db_|database_url|connection_string|private)/i;
  const vars = process.env;
  const hits = [];
  for (const [k, v] of Object.entries(vars)) {
    if (sensitive.test(k) && v) {
      const masked = v.length > 12 ? `${v.slice(0, 4)}***${v.slice(-4)}` : '***masked***';
      hits.push({ name: k, value: masked });
    }
  }
  return hits.slice(0, 50);
}

function probeDir(dir, errors, tag) {
  if (!existsSync(dir)) return { exists: false };
  try {
    const items = readdirSync(dir).slice(0, 50);
    return { exists: true, count: items.length, files: items };
  } catch (e) {
    errors.push(`${tag}: ${String(e?.message ?? e).slice(0, 200)}`);
    return { exists: true, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// ─── Pack J — Virtualization & container surface ───────────────────
function probeVirtualization() {
  const errors = [];
  return {
    errors,
    wsl: probeWslInventory(errors),
    hyperV: probeHyperVInventory(errors),
    docker: probeDockerInventory(errors),
    sandboxEnabled: textPs(`(Get-WindowsOptionalFeature -Online -FeatureName Containers-DisposableClientVM).State`, { errors, tag: 'sandbox' }),
  };
}

function probeWslInventory(errors) {
  if (!haveExe('wsl')) return { installed: false };
  const distros = textPs('wsl --list --verbose --quiet 2>$null', { errors, tag: 'wsl-distros' });
  const configs = {};
  for (const loc of [join(process.env.USERPROFILE || homedir(), '.wslconfig'), 'C:\\Users\\Public\\.wslconfig']) {
    if (existsSync(loc)) {
      try { configs[loc.replace(/\\/g, '/')] = readFileSync(loc, 'utf8').slice(0, 4000); }
      catch { configs[loc.replace(/\\/g, '/')] = 'read error'; }
    }
  }
  // Probe for Kali in WSL
  const isKali = /kali/i.test(distros);
  return { installed: true, distros: distros.split(/\r?\n/).filter(Boolean).slice(0, 20), configs, kaliWsl: isKali };
}

function probeHyperVInventory(errors) {
  try {
    const state = textPs('(Get-WindowsOptionalFeature -Online -FeatureName Microsoft-Hyper-V-All).State', { errors, tag: 'hyperv' });
    if (state !== 'Enabled') return { enabled: false };
    const vms = jsonPs(
      `Get-VM -ErrorAction SilentlyContinue | Select Name,State,Uptime,MemoryAssigned,ProcessorCount,Generation,CreationTime | Sort-Object Name`,
      { errors, tag: 'hyperv-vms' }
    );
    const switches = jsonPs(
      `Get-VMSwitch -ErrorAction SilentlyContinue | Select Name,SwitchType,NetAdapterInterfaceDescription`,
      { errors, tag: 'hyperv-switches' }
    );
    return { enabled: true, vms: sliceList(vms), switches };
  } catch (e) {
    return { enabled: false, error: String(e?.message ?? e).slice(0, 200) };
  }
}

function probeDockerInventory(errors) {
  if (!haveExe('docker')) return { installed: false };
  try {
    const psC = textPs('docker ps --all --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}" 2>$null', { errors, tag: 'docker-ps' });
    const img = textPs('docker images --format "{{.Repository}}:{{.Tag}}|{{.Size}}" 2>$null', { errors, tag: 'docker-images' });
    const ctx = textPs('docker context ls --format "{{.Name}}|{{.Current}}" 2>$null', { errors, tag: 'docker-ctx' });
    const nets = textPs('docker network ls --format "{{.Name}}|{{.Driver}}|{{.Scope}}" 2>$null', { errors, tag: 'docker-nets' });
    return {
      installed: true,
      containers: psC.split(/\r?\n/).filter(Boolean).slice(0, 50),
      images: img.split(/\r?\n/).filter(Boolean).slice(0, 50),
      contexts: ctx.split(/\r?\n/).filter(Boolean).slice(0, 20),
      networks: nets.split(/\r?\n/).filter(Boolean).slice(0, 20),
    };
  } catch (e) {
    return { installed: true, error: String(e?.message ?? e).slice(0, 200) };
  }
}

// ─── Pack K — Service vulnerability surface ────────────────────────
function probeServiceVulns() {
  const errors = [];
  return {
    errors,
    unquotedServicePaths: jsonPs(
      `Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.PathName -and $_.PathName -match '\\.exe' -and $_.PathName -notmatch '^"' -and $_.PathName -notmatch '^\\??\\' } | Select -First 100 | Select Name,DisplayName,PathName,StartName,StartMode,State | Sort-Object Name`,
      { timeoutMs: PS_LONG_TIMEOUT_MS, errors, tag: 'unquoted-paths' }
    ),
    alwaysInstallElevated: {
      hklm: regGet('HKLM:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer', 'AlwaysInstallElevated', errors),
      hkcu: regGet('HKCU:\\SOFTWARE\\Policies\\Microsoft\\Windows\\Installer', 'AlwaysInstallElevated', errors),
    },
    weakServicePermissions: { skipped: 'expensive probe — run with --full-cne for per-service ACL audit' },
    pathInterception: probePathInterception(errors),
    autorunKeys: {
      cmdAutoRun: regGet('HKLM:\\SOFTWARE\\Microsoft\\Command Processor', 'AutoRun', errors),
      psProfileHklm: regGet('HKLM:\\SOFTWARE\\Microsoft\\PowerShell\\1\\ShellIds\\Microsoft.PowerShell', 'ExecutionPolicy', errors),
    },
  };
}

function probePathInterception(errors) {
  // Scan %PATH% for writable directories that precede system dirs.
  const pathDirs = (process.env.PATH || '').split(';').filter(Boolean);
  const systemDir = (process.env.SystemRoot || 'C:\\Windows') + '\\System32';
  const systemIdx = pathDirs.findIndex((d) => d.toLowerCase() === systemDir.toLowerCase());
  const writable = [];
  for (let i = 0; i < pathDirs.length; i++) {
    const d = pathDirs[i].trim();
    if (!d || d === '.') continue;
    try {
      if (existsSync(d)) {
        const st = statSync(d);
        // Check if directory is writable by the current user (not perfect but indicative)
        const testFile = join(d, '.vigil-write-test-' + Date.now());
        try {
          writeFileSync(testFile, 'ok', 'utf8');
          writable.push({ dir: d, index: i, beforeSystem32: systemIdx < 0 ? false : i < systemIdx });
          rmSync(testFile, { force: true });
        } catch { /* not writable */ }
      }
    } catch { /* skip */ }
  }
  return { total: pathDirs.length, writable: writable.length, beforeSystem32: writable.filter((w) => w.beforeSystem32).length, details: writable.slice(0, 30) };
}

// ─── Pack M — OS vulnerability detection ──────────────────────────
function probeOsVulnerabilities() {
  const errors = [];
  const result = {
    errors,
    installedHotfixes: sliceList(jsonPs(
      `Get-HotFix | Sort InstalledOn -Descending | Select HotFixID,Description,InstalledOn,InstalledBy | Select-Object -First 100`,
      { errors, tag: 'hotfixes' }
    )),
    missingPatches: { skipped: 'Windows Update scan requires elevation — run with admin for full patch audit' },
    buildInfo: {
      osVersion: safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').DisplayVersion", 4000),
      build: safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').CurrentBuild", 4000),
      ubr: safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').UBR", 4000),
      edition: safePS("(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion').EditionID", 4000),
      installDate: safePS("(Get-CimInstance Win32_OperatingSystem).InstallDate", 4000),
      lastBoot: safePS("(Get-CimInstance Win32_OperatingSystem).LastBootUpTime", 4000),
      totalVisibleMemoryGB: Math.round((process.env?.NUMBER_OF_PROCESSORS ? 1 : 0) * 0) || null,
    },
    lastPatchDate: textPs('(Get-HotFix | Sort InstalledOn -Descending | Select-Object -First 1).InstalledOn', { errors, tag: 'last-patch' }),
    pendingReboot: textPs("Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending'", { errors, tag: 'reboot' }),
    windowsUpdate: {
      serviceRunning: textPs('(Get-Service wuauserv -ErrorAction SilentlyContinue).Status', { errors, tag: 'wuauserv' }),
      lastCheck: safePS("(New-Object -ComObject Microsoft.Update.AutoUpdate).Results.LastSearchSuccessDate 2>$null", 8000),
    },
  };

  // Try to check for missing security updates (requires PSWindowsUpdate or admin)
  try {
    const missing = textPs(
      `(New-Object -ComObject 'Microsoft.Update.Session').CreateUpdateSearcher().Search('IsInstalled=0 and Type=\\'Software\\' and IsHidden=0').Updates | Select-Object -First 200 | Select Title,MsrcSeverity,SecurityBulletinIDs | Sort-Object MsrcSeverity -Descending`,
      { timeoutMs: 30000, errors, tag: 'missing-updates' }
    );
    if (missing && missing.length > 10) {
      result.missingPatches = { success: true, raw: missing.slice(0, 4000) };
    }
  } catch { /* COM unavailable or no network */ }

  return result;
}

function probeSecurityTools() {
  const errors = [];
  const tools = {
    // AV/EDR
    defender: true, // built-in on modern Windows
    crowdstrike: haveExe('CSFalconService'),
    sentinelOne: haveExe('SentinelAgent'),
    carbonBlack: haveExe('CbDefense'),
    mcafee: haveExe('McAfee'),
    symantec: haveExe('Symantec'),
    trendMicro: haveExe('TrendMicro'),
    sophos: haveExe('Sophos'),
    kaspersky: haveExe('Kaspersky'),
    bitdefender: haveExe('Bitdefender'),
    eset: haveExe('ESET'),
    malwarebytes: haveExe('mbam'),
    // EDR / Hunting
    sysmon: detectSysmon(),
    osquery: haveExe('osqueryd'),
    wazuh: haveExe('wazuh-agent'),
    elasticAgent: haveExe('elastic-agent'),
    splunkForwarder: haveExe('splunk'),
    velociraptor: haveExe('velociraptor'),
    grr: haveExe('grr'),
    // IDS / NSM
    suricata: haveExe('suricata'),
    snort: haveExe('snort'),
    zeek: haveExe('zeek'),
    wireshark: haveExe('wireshark') || haveExe('tshark'),
    nmap: haveExe('nmap'),
    // Forensics / RE
    kape: haveExe('kape'),
    volatility: haveExe('volatility3') || haveExe('volatility'),
    // Kali Linux (WSL or native)
    kali: probeKaliPresence(errors),
    // Reverse engineering
    ghidra: haveExe('ghidraRun') || haveExe('ghidra'),
    ida: haveExe('ida64') || haveExe('ida'),
    x64dbg: haveExe('x64dbg'),
    dnSpy: haveExe('dnSpy'),
    peBear: haveExe('PE-bear'),
    ollydbg: haveExe('ollydbg'),
    // Static analysis
    dependencyCheck: haveExe('dependency-check'),
    trivy: haveExe('trivy'),
    grype: haveExe('grype'),
    snyk: haveExe('snyk'),
    // Baselines / compliance
    lynis: haveExe('lynis'),
    openscap: haveExe('oscap'),
    inspec: haveExe('inspec'),
    kubeBench: haveExe('kube-bench'),
    // Cloud
    aws: haveExe('aws'),
    gcloud: haveExe('gcloud'),
    az: haveExe('az'),
    firebase: haveExe('firebase'),
    terraform: haveExe('terraform'),
    kubectl: haveExe('kubectl'),
    // DevSecOps
    git: haveExe('git'),
    python: haveExe('python') || haveExe('python3'),
    ruby: haveExe('ruby'),
    go: haveExe('go'),
    rust: haveExe('cargo'),
  };
  return { errors, tools };
}

function detectSysmon() {
  try {
    const svc = textPs('(Get-Service Sysmon* -ErrorAction SilentlyContinue | Select -First 1).Status', { tag: 'sysmon' });
    return svc === 'Running';
  } catch { return false; }
}

function probeKaliPresence(errors) {
  // Check WSL Kali, native dual-boot Kali, or Kali VM
  const indicators = [];
  if (haveExe('wsl')) {
    const wslDistros = textPs('wsl --list --quiet 2>$null', { errors, tag: 'kali-wsl' });
    if (/kali/i.test(wslDistros)) indicators.push('wsl-kali-distro');
  }
  if (haveExe('kali')) indicators.push('kali-command');
  if (existsSync('C:\\Program Files\\Kali Linux')) indicators.push('kali-native-dir');
  // Check for Kali tools
  const kaliTools = ['msfconsole', 'sqlmap', 'hydra', 'john', 'hashcat', 'aircrack-ng', 'burpsuite', 'nikto', 'dirb', 'gobuster', 'wfuzz', 'responder', 'mimikatz'];
  const found = kaliTools.filter((t) => haveExe(t));
  if (found.length > 0) indicators.push(`kali-tools:${found.length}`);
  return { detected: indicators.length > 0, indicators, toolsFound: found };
}

function checkDebugger(imageName, errors) {
  const v = regGet(`HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\${imageName}`, 'Debugger', errors);
  return { hijacked: !!v, debugger: v || null };
}

// ─── helpers ──────────────────────────────────────────────────────
function safePS(expr, timeoutMs = PS_TIMEOUT_MS) {
  try {
    const out = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', expr], {
      encoding: 'utf8', timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: (out.status ?? -1) === 0, stdout: (out.stdout ?? '').trim(), stderr: (out.stderr ?? '').trim() };
  } catch (e) {
    return { ok: false, stdout: '', stderr: String(e?.message ?? e).slice(0, 240) };
  }
}

function textPs(expr, { timeoutMs = PS_TIMEOUT_MS, errors, tag } = {}) {
  const r = safePS(expr, timeoutMs);
  if (!r.ok && r.stderr && errors) errors.push(`${tag ?? 'ps'}: ${r.stderr.slice(0, 240)}`);
  return r.stdout;
}

function jsonPs(expr, { timeoutMs = PS_TIMEOUT_MS, errors, tag, depth = 4 } = {}) {
  // Use `& { ... }` script-block invocation so multi-statement
  // expressions (assignments + foreach + final pipeline) work the same
  // as single pipelines. `( ... )` only accepts a single expression.
  const wrapped = `& { ${expr} } | ConvertTo-Json -Compress -Depth ${depth}`;
  const r = safePS(wrapped, timeoutMs);
  if (!r.ok) {
    if (errors) errors.push(`${tag ?? 'json-ps'}: ${(r.stderr || 'exit').slice(0, 240)}`);
    return null;
  }
  if (!r.stdout) return null;
  try { return JSON.parse(r.stdout); }
  catch {
    if (errors) errors.push(`${tag ?? 'json-ps'}: parse failed`);
    return r.stdout.slice(0, 2000);
  }
}

function regGet(path, valueName, errors) {
  // -ErrorAction SilentlyContinue makes missing keys/values return $null cleanly.
  const expr = `(Get-ItemProperty '${path.replace(/'/g, "''")}' -ErrorAction SilentlyContinue).'${valueName.replace(/'/g, "''")}'`;
  const r = safePS(expr, 6000);
  if (!r.ok && r.stderr && errors) errors.push(`reg ${path}\\${valueName}: ${r.stderr.slice(0, 200)}`);
  return r.stdout || null;
}

function haveExe(name) {
  const r = spawnSync('where', [name], { encoding: 'utf8', windowsHide: true, timeout: 4000 });
  return ((r.stdout ?? '').split(/\r?\n/).filter(Boolean)[0]) ? true : false;
}

function sliceList(list) {
  if (!Array.isArray(list)) return list;
  if (list.length <= TRUNCATE_LIST) return list;
  return { truncated: true, total: list.length, sample: list.slice(0, TRUNCATE_LIST) };
}

#!/usr/bin/env bash
# ────────────────────────────────────────────────────
# Vigil CNE — One-command cross-platform installer
# Detects OS, installs dependencies, configures Vigil
# with all MCP servers. Works on:
#   - Kali / Debian / Ubuntu
#   - macOS (Homebrew)
#   - Windows (WSL / Git Bash)
#   - Any Linux with apt, dnf, pacman, or zypper
# ────────────────────────────────────────────────────
set -euo pipefail

BOLD="\033[1m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
CYAN="\033[36m"
RESET="\033[0m"

header() { echo -e "\n${BOLD}${CYAN}═══ $1 ═══${RESET}"; }
ok()    { echo -e "  ${GREEN}✓${RESET} $1"; }
warn()  { echo -e "  ${YELLOW}⚠${RESET} $1"; }
fail()  { echo -e "  ${RED}✗${RESET} $1"; }

header "Vigil CNE — Universal Installer"

# ── Detect OS ──
OS="$(uname -s)"
case "$OS" in
  Linux)  OS_FAMILY="linux" ;;
  Darwin) OS_FAMILY="macos" ;;
  MINGW*|MSYS*|CYGWIN*) OS_FAMILY="windows" ;;
  *)      OS_FAMILY="unknown" ;;
esac

ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64)  ARCH="x64" ;;
  aarch64|arm64)  ARCH="arm64" ;;
esac

echo -e "  OS:     ${CYAN}${OS_FAMILY}${RESET} (${OS})"
echo -e "  Arch:   ${CYAN}${ARCH}${RESET}"
echo -e "  Shell:  ${CYAN}${SHELL}${RESET}"

# ── Package manager detection ──
PKG_MGR=""
if command -v apt-get &>/dev/null; then
  PKG_MGR="apt"
elif command -v dnf &>/dev/null; then
  PKG_MGR="dnf"
elif command -v yum &>/dev/null; then
  PKG_MGR="yum"
elif command -v pacman &>/dev/null; then
  PKG_MGR="pacman"
elif command -v zypper &>/dev/null; then
  PKG_MGR="zypper"
elif command -v brew &>/dev/null; then
  PKG_MGR="brew"
elif command -v winget &>/dev/null; then
  PKG_MGR="winget"
fi

# ────────────────────────────────────────────────────
# Step 1: Node.js
# ────────────────────────────────────────────────────
header "1/5 — Node.js"

if command -v node &>/dev/null; then
  NODE_VER="$(node --version)"
  ok "Node.js ${NODE_VER} already installed"
else
  case "$PKG_MGR" in
    apt)
      curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
      sudo apt-get install -y nodejs
      ;;
    dnf|yum)
      curl -fsSL https://rpm.nodesource.com/setup_22.x | sudo -E bash -
      sudo "$PKG_MGR" install -y nodejs
      ;;
    brew)
      brew install node@22
      ;;
    pacman)
      sudo pacman -S --noconfirm nodejs npm
      ;;
    *)
      warn "No package manager. Install Node.js 22 from https://nodejs.org"
      ;;
  esac
  ok "Node.js installed"
fi

# ────────────────────────────────────────────────────
# Step 2: Vigil CLI
# ────────────────────────────────────────────────────
header "2/5 — Vigil CLI"

if command -v vigil &>/dev/null; then
  VIGIL_VER="$(vigil --version 2>/dev/null || echo 'installed')"
  ok "Vigil already installed"
else
  npm install -g @trenchwork/vigil@latest
  ok "Vigil installed globally"
fi

# ────────────────────────────────────────────────────
# Step 3: Kali / Security tools (Linux only)
# ────────────────────────────────────────────────────
header "3/5 — Security Tools"

if [ "$OS_FAMILY" = "linux" ]; then
  case "$PKG_MGR" in
    apt)
      echo "  Installing defensive + offensive toolkit via apt..."
      sudo apt-get update -qq
      sudo apt-get install -y -qq --no-install-recommends \
        nmap tcpdump iptables nftables ufw \
        lynis chkrootkit rkhunter clamav \
        sleuthkit foremost binwalk exiftool \
        radare2 gdb ltrace strace checksec \
        nikto sqlmap gobuster dirb whatweb \
        hashcat john hydra crunch hash-identifier \
        metasploit-framework searchsploit \
        eyewitness curl wget git unzip \
        openjdk-17-jdk-headless \
        2>/dev/null || warn "Some packages unavailable — Kali recommended for full toolkit"
      ;;
    brew)
      brew install nmap lynis clamav radare2 gdb binwalk exiftool nikto sqlmap hashcat john hydra metasploit curl wget
      ;;
    *)
      warn "Skipping Kali tools — install manually or use Docker image"
      ;;
  esac
  ok "Security tools installed (or partially installed)"
else
  warn "Non-Linux OS — install security tools manually or use: docker run -it trenchwork/vigil"
fi

# ────────────────────────────────────────────────────
# Step 4: Ghidra (optional, interactive prompt)
# ────────────────────────────────────────────────────
header "4/5 — Ghidra Reverse Engineering"

GHIDRA_DIR="${GHIDRA_INSTALL_DIR:-/opt/ghidra}"
if [ -f "$GHIDRA_DIR/support/analyzeHeadless" ]; then
  ok "Ghidra found at $GHIDRA_DIR"
elif [ -d "/opt/ghidra/support" ] && [ -f "/opt/ghidra/support/analyzeHeadless" ]; then
  ok "Ghidra found at /opt/ghidra"
  GHIDRA_DIR="/opt/ghidra"
else
  echo ""
  echo -e "  ${YELLOW}Ghidra not detected.${RESET}"
  read -rp "  Install Ghidra? (requires ~2GB disk) [y/N] " INSTALL_GHIDRA
  if [ "${INSTALL_GHIDRA,,}" = "y" ]; then
    GHIDRA_VERSION="11.3"
    GHIDRA_URL="https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/Ghidra_${GHIDRA_VERSION}_PUBLIC_20250219.zip"

    sudo mkdir -p /opt
    echo "  Downloading Ghidra ${GHIDRA_VERSION}..."
    curl -sSL -o /tmp/ghidra.zip "$GHIDRA_URL"
    sudo unzip -qo /tmp/ghidra.zip -d /opt
    sudo mv /opt/ghidra_*_PUBLIC /opt/ghidra
    sudo chmod +x /opt/ghidra/support/analyzeHeadless
    rm /tmp/ghidra.zip
    GHIDRA_DIR="/opt/ghidra"
    ok "Ghidra ${GHIDRA_VERSION} installed at $GHIDRA_DIR"
  else
    warn "Skipping Ghidra — binary analysis will be unavailable"
  fi
fi

# ────────────────────────────────────────────────────
# Step 5: Vigil MCP Configuration
# ────────────────────────────────────────────────────
header "5/5 — MCP Server Configuration"

VIGIL_MCP_DIR="${HOME}/.vigil"
mkdir -p "$VIGIL_MCP_DIR"

# Write MCP config with all servers
cat > "${VIGIL_MCP_DIR}/mcp.json" << 'MCPEOF'
{
  "mcpServers": {
    "ghidra": {
      "command": "node",
      "args": ["scripts/ghidra-mcp-server.mjs"],
      "env": {
        "GHIDRA_INSTALL_DIR": "/opt/ghidra"
      },
      "profiles": ["vigil-code"]
    },
    "kali-tools": {
      "command": "node",
      "args": ["scripts/kali-tools-mcp.mjs"],
      "profiles": ["vigil-code"]
    },
    "network-defense": {
      "command": "node",
      "args": ["scripts/network-defense-mcp.mjs"],
      "profiles": ["vigil-code"]
    },
    "threat-feed": {
      "command": "node",
      "args": ["scripts/threat-feed-mcp.mjs"],
      "profiles": ["vigil-code"]
    },
    "endpoint-defense": {
      "command": "node",
      "args": ["scripts/endpoint-defense-mcp.mjs"],
      "profiles": ["vigil-code"]
    }
  }
}
MCPEOF

ok "MCP config written to ${VIGIL_MCP_DIR}/mcp.json"

# ── Update PATH ──
if [ -n "${GHIDRA_DIR:-}" ]; then
  if ! grep -q "GHIDRA_INSTALL_DIR" "${HOME}/.bashrc" 2>/dev/null; then
    echo "export GHIDRA_INSTALL_DIR=${GHIDRA_DIR}" >> "${HOME}/.bashrc"
  fi
  if ! grep -q "GHIDRA_INSTALL_DIR" "${HOME}/.zshrc" 2>/dev/null; then
    echo "export GHIDRA_INSTALL_DIR=${GHIDRA_DIR}" >> "${HOME}/.zshrc"
  fi
  ok "GHIDRA_INSTALL_DIR set to ${GHIDRA_DIR}"
fi

# ────────────────────────────────────────────────────
# Done
# ────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}${GREEN}═══ Vigil CNE Installation Complete ═══${RESET}"
echo ""
echo -e "  ${BOLD}Quick start:${RESET}"
echo -e "    ${CYAN}vigil${RESET}                  # Interactive CNE agent"
echo -e "    ${CYAN}vigil /vuln${RESET}             # Vulnerability discovery"
echo -e "    ${CYAN}vigil /harden${RESET}           # System hardening"
echo -e "    ${CYAN}vigil --headless \"scan my repo for vulnerabilities\"${RESET}"
echo ""
echo -e "  ${BOLD}Docker (air-gapped / cloud):${RESET}"
echo -e "    ${CYAN}docker run -it -v \$(pwd):/workspace trenchwork/vigil vigil /scan${RESET}"
echo ""
echo -e "  ${BOLD}GitHub Actions:${RESET}"
echo -e "    ${CYAN}# Add .github/workflows/vigil-scan.yml to your repo${RESET}"
echo ""
echo -e "  ${BOLD}Documentation:${RESET}  https://trenchwork.org/security"
echo ""

# Auto-start vigil if requested
if [ "${1:-}" = "--start" ]; then
  vigil
fi

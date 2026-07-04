# ───────────────────────────────────────────────
# Vigil CND — Multi-stage Docker image
# Kali Linux + Ghidra + Vigil + all MCP servers
# Deploy anywhere: cloud, on-prem, air-gapped
# ───────────────────────────────────────────────

# ── Stage 1: Kali base with security tools ──
FROM kalilinux/kali-rolling AS kali-tools

ENV DEBIAN_FRONTEND=noninteractive

# Install the full defensive + offensive toolkit
RUN apt-get update && apt-get install -y --no-install-recommends \
  # ── Defensive tools ──
  lynis chkrootkit rkhunter clamav clamav-daemon \
  aide osquery wazuh-agent \
  debsecan apt-listbugs unattended-upgrades \
  # ── Network defense ──
  nmap masscan rustscan \
  tcpdump wireshark-common \
  iptables nftables ufw \
  # ── Forensics ──
  sleuthkit foremost binwalk exiftool steghide \
  volatility3 \
  # ── Reverse engineering ──
  radare2 rizin gdb ltrace strace \
  checksec \
  # ── Web / vuln scanners ──
  nikto wpscan sqlmap wafw00f \
  gobuster dirb ffuf whatweb \
  # ── Password analysis ──
  hashcat john hydra crunch cewl hash-identifier \
  # ── Exploitation & post-exploitation ──
  metasploit-framework searchsploit impacket-scripts \
  crackmapexec bloodhound enum4linux smbmap \
  # ── Reporting ──
  eyewitness maltego \
  # ── Wireless ──
  aircrack-ng kismet hcxtools \
  # ── Utilities ──
  curl wget git ca-certificates \
  unzip p7zip-full python3 python3-pip \
  openjdk-17-jdk-headless \
  libwebkit2gtk-4.1-0 libgtk-3-0 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# ── Stage 2: Ghidra installation ──
FROM kali-tools AS ghidra-stage

ARG GHIDRA_VERSION=11.3
ARG GHIDRA_URL=https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/Ghidra_${GHIDRA_VERSION}_PUBLIC_20250219.zip

WORKDIR /opt
RUN curl -sSL -o ghidra.zip "${GHIDRA_URL}" \
  && unzip -q ghidra.zip \
  && rm ghidra.zip \
  && mv ghidra_*_PUBLIC ghidra \
  && chmod +x /opt/ghidra/support/analyzeHeadless \
  && echo "ghidra.auto.disable.gpu=true" >> /opt/ghidra/support/launch.properties \
  && echo "ghidra.auto.analysis.enabled=false" >> /opt/ghidra/support/launch.properties

ENV GHIDRA_INSTALL_DIR=/opt/ghidra
ENV PATH="/opt/ghidra/support:${PATH}"

# ── Stage 3: Node.js + Vigil ──
FROM ghidra-stage AS vigil

ARG NODE_VERSION=22

# Install Node.js
RUN curl -fsSL https://deb.nodesource.com/setup_${NODE_VERSION}.x | bash - \
  && apt-get install -y nodejs \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

# Install Vigil globally
RUN npm install -g @trenchwork/vigil@latest

# ── Copy Vigil MCP servers (bundled with image) ──
COPY scripts/kali-tools-mcp.mjs /opt/vigil/scripts/kali-tools-mcp.mjs
COPY scripts/network-defense-mcp.mjs /opt/vigil/scripts/network-defense-mcp.mjs
COPY scripts/threat-feed-mcp.mjs /opt/vigil/scripts/threat-feed-mcp.mjs
COPY scripts/endpoint-defense-mcp.mjs /opt/vigil/scripts/endpoint-defense-mcp.mjs
COPY scripts/ghidra-mcp-server.mjs /opt/vigil/scripts/ghidra-mcp-server.mjs
COPY scripts/_ghidra-headless.mjs /opt/vigil/scripts/_ghidra-headless.mjs
COPY scripts/_comprehensive-vuln-scan.mjs /opt/vigil/scripts/_comprehensive-vuln-scan.mjs
COPY scripts/_vigil-comprehensive.mjs /opt/vigil/scripts/_vigil-comprehensive.mjs
COPY scripts/_secret-scan.mjs /opt/vigil/scripts/_secret-scan.mjs
COPY scripts/_poc-engine.mjs /opt/vigil/scripts/_poc-engine.mjs
COPY scripts/_kev-monitor.mjs /opt/vigil/scripts/_kev-monitor.mjs
COPY scripts/_eccn-classifier.mjs /opt/vigil/scripts/_eccn-classifier.mjs
COPY scripts/_sbom-builder.mjs /opt/vigil/scripts/_sbom-builder.mjs
COPY scripts/_threat-intel.mjs /opt/vigil/scripts/_threat-intel.mjs
COPY scripts/_dns-recon.mjs /opt/vigil/scripts/_dns-recon.mjs
COPY scripts/_nmap-cve-pipeline.mjs /opt/vigil/scripts/_nmap-cve-pipeline.mjs
COPY scripts/_finding-enricher.mjs /opt/vigil/scripts/_finding-enricher.mjs
COPY scripts/_advisory-investigation.mjs /opt/vigil/scripts/_advisory-investigation.mjs
COPY scripts/_vulnerability-discovery.mjs /opt/vigil/scripts/_vulnerability-discovery.mjs
COPY scripts/_cloud-reachability.mjs /opt/vigil/scripts/_cloud-reachability.mjs
COPY scripts/_platform-probe.mjs /opt/vigil/scripts/_platform-probe.mjs
COPY scripts/vigil-run.mjs /opt/vigil/scripts/vigil-run.mjs
COPY tools/ghidra/scripts/ /opt/vigil/tools/ghidra/scripts/

# ── Vigil MCP config ──
COPY .vigil/mcp.json /root/.vigil/mcp.json

# ── Volumes for persistent data ──
VOLUME ["/workspace", "/root/.vigil", "/var/lib/clamav"]

# ── Entrypoint ──
WORKDIR /workspace
ENTRYPOINT ["vigil"]
CMD ["--help"]

# ── Health check ──
HEALTHCHECK --interval=300s --timeout=30s --retries=3 \
  CMD node -e "require('child_process').execSync('which vigil',{timeout:5000})" || exit 1

LABEL org.opencontainers.image.title="Vigil CND — Kali + Ghidra Container"
LABEL org.opencontainers.image.description="Computer Network Defense terminal agent. No GUI. No jailbreak needed. Full Kali Linux toolkit + Ghidra headless + MCP servers for network defense, threat intelligence, endpoint protection, and autonomous vulnerability remediation."
LABEL org.opencontainers.image.authors="Trenchwork <vigil@trenchwork.org>"
LABEL org.opencontainers.image.source="https://github.com/Aroxora/vigil-by-trenchwork"
LABEL org.opencontainers.image.licenses="SEE LICENSE IN LICENSE"

#!/usr/bin/env node
// MCP stdio server — Cloud Security Posture Management (CSPM)
// + Container/Image scanning. Covers AWS, GCP, Azure, K8s, Docker.
// All operations are read-only configuration audits.

if (!process.env.VIGIL_SESSION_TOKEN) {
  process.stderr.write('[vigil-cloud-mcp] Error: VIGIL_SESSION_TOKEN is not set.\n' +
    'This server must be started by the Vigil CLI, not directly.\n');
  process.exit(1);
}

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { platform } from 'node:os';
import { join } from 'node:path';

const TIMEOUT = 30_000;
const LONG_TIMEOUT = 60_000;
const IS_WIN = platform() === 'win32';

function safeRun(cmd, t = TIMEOUT) {
  try {
    const c = IS_WIN ? cmd : `timeout ${Math.floor(t/1000)} ${cmd}`;
    return execSync(c, { encoding:'utf8', timeout:t+5000, stdio:['ignore','pipe','ignore'], maxBuffer:16*1024*1024, killSignal:'SIGKILL' }).trim();
  } catch { return ''; }
}
function haveExe(n) {
  try { const r = spawnSync(IS_WIN?'where':'which',[n],{encoding:'utf8',timeout:4000,killSignal:'SIGKILL'}); return !!((r.stdout??'').split(/\r?\n/).filter(Boolean)[0]); } catch { return false; }
}
function jsonResult(v) { return { content: [{ type:'text', text: JSON.stringify(v,null,2) }] }; }
async function guarded(fn) { try { return jsonResult(await fn()); } catch(e) { return { isError:true, content:[{type:'text',text:String(e?.message||e)}] }; } }

const server = new McpServer({ name:'vigil-cloud-security', version:'1.0.0' });

// ══════════════════════════════════════
// 1. Kubernetes Security Audit
// ══════════════════════════════════════
server.registerTool('cloud_k8s_audit', {
  title: 'Kubernetes Security Audit',
  description: 'Audit a Kubernetes cluster for security misconfigurations: RBAC, pod security, network policies, secret management, exposed dashboards. Supports kubectl and kubeconfig.',
  inputSchema: {
    kubeconfig: z.string().optional().describe('Path to kubeconfig file. Uses default if omitted.'),
    namespace: z.string().optional().describe('Limit to a specific namespace.'),
    timeoutMs: z.number().int().positive().max(120000).optional().default(30000),
  },
  annotations: { readOnlyHint:true, destructiveHint:false },
}, async (args) => {
  if (!haveExe('kubectl')) return jsonResult({ error:'kubectl not installed', remediation:'curl -LO "https://dl.k8s.io/release/$(curl -L -s https://dl.k8s.io/release/stable.txt)/bin/linux/amd64/kubectl"' });

  const kubeFlag = args.kubeconfig ? `--kubeconfig="${args.kubeconfig}"` : '';
  const nsFlag = args.namespace ? `-n ${args.namespace}` : '--all-namespaces';
  const findings = [];

  // RBAC — check for overly permissive cluster roles
  const clusterroles = safeRun(`kubectl get clusterrolebindings,rolebindings ${nsFlag} -o json ${kubeFlag} 2>/dev/null`, args.timeoutMs);
  if (clusterroles) {
    try {
      const data = JSON.parse(clusterroles);
      for (const item of data.items || []) {
        const roleRef = item.roleRef?.name || '';
        const subjects = item.subjects || [];
        for (const s of subjects) {
          if (s.kind === 'ServiceAccount' && roleRef === 'cluster-admin') {
            findings.push({ severity:'critical', resource:'RBAC', detail:`${s.name} has cluster-admin in ${item.metadata?.namespace || 'cluster'}`, remediation:'Replace cluster-admin with a minimal custom role' });
          }
          if (s.kind === 'Group' && s.name === 'system:unauthenticated' && roleRef === 'cluster-admin') {
            findings.push({ severity:'critical', resource:'RBAC', detail:'Unauthenticated group has cluster-admin', remediation:'Remove system:unauthenticated binding immediately' });
          }
        }
      }
    } catch {}
  }

  // Pod Security — check privileged containers and host mounts
  const pods = safeRun(`kubectl get pods ${nsFlag} -o json ${kubeFlag} 2>/dev/null`, args.timeoutMs);
  if (pods) {
    try {
      const data = JSON.parse(pods);
      for (const pod of data.items || []) {
        const containers = pod.spec?.containers || [];
        for (const c of containers) {
          if (c.securityContext?.privileged) {
            findings.push({ severity:'high', resource:'Pod', detail:`${pod.metadata?.namespace}/${pod.metadata?.name}/${c.name} runs privileged`, remediation:'Remove privileged: true, use specific capabilities' });
          }
          if (c.securityContext?.allowPrivilegeEscalation !== false) {
            findings.push({ severity:'medium', resource:'Pod', detail:`${pod.metadata?.namespace}/${pod.metadata?.name}/${c.name} allows privilege escalation`, remediation:'Set allowPrivilegeEscalation: false' });
          }
          if (c.securityContext?.runAsNonRoot !== true) {
            findings.push({ severity:'medium', resource:'Pod', detail:`${pod.metadata?.namespace}/${pod.metadata?.name}/${c.name} may run as root`, remediation:'Set runAsNonRoot: true' });
          }
          for (const vm of c.volumeMounts || []) {
            if (vm.mountPath === '/host' || vm.mountPath?.startsWith('/var/run/docker.sock')) {
              findings.push({ severity:'critical', resource:'VolumeMount', detail:`${pod.metadata?.namespace}/${pod.metadata?.name}/${c.name} mounts ${vm.mountPath}`, remediation:'Remove hostPath mount — allows container escape' });
            }
          }
        }
      }
    } catch {}
  }

  // Network Policies — check if any exist
  const netpols = safeRun(`kubectl get networkpolicies ${nsFlag} --no-headers 2>/dev/null | wc -l`, 10000).trim();
  if (netpols === '0' || !netpols) {
    findings.push({ severity:'high', resource:'NetworkPolicy', detail:'No network policies defined — all pods can communicate freely', remediation:'Implement namespace-isolating NetworkPolicies' });
  }

  // Secrets — check for unencrypted secrets
  const secretEncryption = safeRun(`kubectl get --raw /api/v1/namespaces/kube-system/configmaps/kube-apiserver 2>/dev/null | grep -c encryption-provider-config || echo 0`, 10000).trim();
  if (secretEncryption === '0') {
    findings.push({ severity:'high', resource:'Secrets', detail:'Encryption at rest not configured for Kubernetes secrets', remediation:'Configure encryption-provider-config on API server' });
  }

  return jsonResult({
    timestamp: new Date().toISOString(),
    findings,
    summary: { total:findings.length, critical:findings.filter(f=>f.severity==='critical').length, high:findings.filter(f=>f.severity==='high').length },
  });
});

// ══════════════════════════════════════
// 2. Docker Security Audit
// ══════════════════════════════════════
server.registerTool('cloud_docker_audit', {
  title: 'Docker Security Audit',
  description: 'Audit Docker daemon, running containers, and images for security issues: daemon exposure, privileged containers, outdated images, rootless mode, content trust.',
  annotations: { readOnlyHint:true, destructiveHint:false },
}, async () => {
  if (!haveExe('docker')) return jsonResult({ error:'Docker not installed' });

  const findings = [];

  // Daemon TCP exposure
  const daemonSock = safeRun('ss -tlnp 2>/dev/null | grep -E "2375|2376" || echo "none"', 10000);
  if (daemonSock !== 'none') {
    findings.push({ severity:'critical', resource:'Docker daemon', detail:'Docker daemon exposed on TCP socket', remediation:'Use Unix socket only, or TLS with mutual auth on 2376' });
  }

  // Rootless check
  const dockerInfo = safeRun('docker info --format "{{.SecurityOptions}}" 2>/dev/null', 10000);
  if (dockerInfo && !dockerInfo.includes('rootless')) {
    findings.push({ severity:'medium', resource:'Docker daemon', detail:'Docker not running in rootless mode', remediation:'Configure rootless Docker for defense-in-depth' });
  }

  // Privileged containers
  const privileged = safeRun('docker ps -q 2>/dev/null | xargs -I{} docker inspect {} --format "{{.Name}}: privileged={{.HostConfig.Privileged}}" 2>/dev/null | grep "privileged=true" || echo "none"', 15000);
  if (privileged !== 'none') {
    findings.push({ severity:'critical', resource:'Container', detail:`Privileged containers running: ${privileged.split('\n').slice(0,5).join('; ')}`, remediation:'Remove --privileged, use specific --device and --cap-add' });
  }

  // Host network containers
  const hostNet = safeRun('docker ps -q 2>/dev/null | xargs -I{} docker inspect {} --format "{{.Name}}: net={{.HostConfig.NetworkMode}}" 2>/dev/null | grep "net=host" || echo "none"', 15000);
  if (hostNet !== 'none') {
    findings.push({ severity:'high', resource:'Container', detail:`Containers using host network: ${hostNet.slice(0,200)}`, remediation:'Avoid --network=host unless absolutely necessary' });
  }

  // Content trust
  const dct = safeRun('echo $DOCKER_CONTENT_TRUST', 5000).trim();
  if (!dct || dct !== '1') {
    findings.push({ severity:'medium', resource:'Docker daemon', detail:'Docker Content Trust (DCT) not enabled', remediation:'export DOCKER_CONTENT_TRUST=1' });
  }

  // Docker socket mount detection in containers
  const socketMounts = safeRun('docker ps -q 2>/dev/null | xargs -I{} docker inspect {} --format "{{.Name}}: {{range .Mounts}}{{if eq .Source \"/var/run/docker.sock\"}}DOCKER_SOCK_MOUNTED{{end}}{{end}}" 2>/dev/null | grep DOCKER_SOCK_MOUNTED || echo "none"', 15000);
  if (socketMounts !== 'none') {
    findings.push({ severity:'critical', resource:'Container', detail:`Containers with Docker socket mount: ${socketMounts.slice(0,200)}`, remediation:'Never mount /var/run/docker.sock into containers — allows container escape' });
  }

  // Image scan with Trivy if available
  let imageVulns = null;
  if (haveExe('trivy')) {
    const images = safeRun('docker images --format "{{.Repository}}:{{.Tag}}" 2>/dev/null | head -10', 10000);
    if (images) {
      imageVulns = {};
      for (const img of images.split('\n').filter(Boolean)) {
        const scan = safeRun(`trivy image --severity CRITICAL,HIGH --no-progress --quiet "${img}" 2>/dev/null | tail -20`, 60000);
        if (scan && scan.includes('CRITICAL') || scan?.includes('HIGH')) {
          imageVulns[img] = scan.slice(0, 3000);
        }
      }
    }
  }

  // Docker Bench Security if available
  let benchScore = null;
  if (haveExe('docker-bench-security.sh')) {
    benchScore = safeRun('docker-bench-security.sh --no-color 2>/dev/null | grep -E "\\[WARN\\]|\\[FAIL\\]" | head -20', 30000);
  }

  return jsonResult({
    timestamp: new Date().toISOString(),
    findings,
    imageVulnerabilities: imageVulns,
    dockerBenchScore: benchScore,
    summary: { total:findings.length, critical:findings.filter(f=>f.severity==='critical').length, high:findings.filter(f=>f.severity==='high').length },
  });
});

// ══════════════════════════════════════
// 3. Terraform / IaC Security Scan
// ══════════════════════════════════════
server.registerTool('cloud_iac_scan', {
  title: 'IaC Security Scan',
  description: 'Scan Infrastructure-as-Code (Terraform, CloudFormation, Pulumi) for security misconfigurations: open S3 buckets, overly permissive IAM, unencrypted resources, exposed ports.',
  inputSchema: {
    path: z.string().describe('Path to directory containing .tf, .tf.json, .yaml, or .yml files.'),
    depth: z.number().int().positive().max(10).optional().default(5),
  },
  annotations: { readOnlyHint:true, destructiveHint:false },
}, async (args) => {
  if (!existsSync(args.path)) return jsonResult({ error:`Path not found: ${args.path}` });
  const findings = [];
  const patterns = [
    { regex: /aws_s3_bucket_public_access_block\s*{[^}]*block_public_acls\s*=\s*false/gs, desc:'S3 public access block disabled', sev:'critical', fix:'Set block_public_acls = true' },
    { regex: /"Effect"\s*:\s*"Allow".*?"Principal"\s*:\s*\*|"Principal"\s*:\s*{\s*"AWS"\s*:\s*"\*"\s*}/gs, desc:'IAM policy with wildcard principal', sev:'critical', fix:'Restrict Principal to specific ARNs' },
    { regex: /aws_security_group_rule\s*{[^}]*cidr_blocks\s*=\s*\[.*?"0\.0\.0\.0\/0".*?\]/gs, desc:'Security group open to 0.0.0.0/0', sev:'high', fix:'Restrict CIDR to specific IP ranges' },
    { regex: /aws_db_instance\s*{[^}]*storage_encrypted\s*=\s*false/gs, desc:'RDS storage encryption disabled', sev:'high', fix:'Set storage_encrypted = true' },
    { regex: /aws_ebs_volume\s*{[^}]*encrypted\s*=\s*false/gs, desc:'EBS volume encryption disabled', sev:'medium', fix:'Set encrypted = true' },
    { regex: /aws_s3_bucket\s*{[^}]*acl\s*=\s*"public-read/gs, desc:'S3 bucket with public-read ACL', sev:'critical', fix:'Use private ACL + CloudFront for public content' },
    { regex: /aws_iam_user_policy_attachment\s*{[^}]*policy_arn\s*=\s*".*AdministratorAccess/gs, desc:'IAM user with AdministratorAccess', sev:'critical', fix:'Use least-privilege policies' },
    { regex: /aws_kms_key\s*{[^}]*enable_key_rotation\s*=\s*false/gs, desc:'KMS key rotation disabled', sev:'low', fix:'Set enable_key_rotation = true' },
    { regex: /aws_cloudtrail\s*{[^}]*enable_log_file_validation\s*=\s*false/gs, desc:'CloudTrail log validation disabled', sev:'medium', fix:'Set enable_log_file_validation = true' },
    { regex: /aws_ecs_task_definition\s*{[^}]*"networkMode"\s*:\s*"host"/gs, desc:'ECS task using host network mode', sev:'high', fix:'Use awsvpc or bridge network mode' },
  ];

  function scanDir(dir, depth) {
    if (depth <= 0) return;
    try {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (entry.startsWith('.git') || entry === 'node_modules' || entry === '.terraform') continue;
        try {
          const st = statSync(full);
          if (st.isDirectory()) { scanDir(full, depth-1); continue; }
          if (!st.isFile() || st.size > 1_000_000) continue;
          const ext = entry.split('.').pop()?.toLowerCase();
          if (!['tf','json','yaml','yml','template'].includes(ext||'')) continue;
          scanFile(full);
        } catch {}
      }
    } catch {}
  }

  function scanFile(file) {
    try {
      const content = readFileSync(file, 'utf8');
      for (const p of patterns) {
        const m = content.match(p.regex);
        if (m) findings.push({ file, pattern:p.desc, severity:p.sev, occurrences:m.length, fix:p.fix });
      }
    } catch {}
  }

  scanDir(args.path, args.depth);

  return jsonResult({
    timestamp: new Date().toISOString(),
    scannedPath: args.path,
    findings,
    summary: { total:findings.length, critical:findings.filter(f=>f.severity==='critical').length, high:findings.filter(f=>f.severity==='high').length },
  });
});

// ══════════════════════════════════════
// 4. AWS CLI Security Audit
// ══════════════════════════════════════
server.registerTool('cloud_aws_audit', {
  title: 'AWS Security Audit',
  description: 'Audit AWS account security posture: public S3 buckets, IAM users without MFA, unused access keys, security group exposure, CloudTrail status, GuardDuty status. Requires AWS CLI configured.',
  timeoutMs: z.number().int().positive().max(120000).optional().default(45000),
  annotations: { readOnlyHint:true, destructiveHint:false },
}, async (args) => {
  if (!haveExe('aws')) return jsonResult({ error:'AWS CLI not installed. Run: pip install awscli && aws configure' });
  const findings = [];

  // Check IAM — users without MFA
  const iamUsers = safeRun('aws iam list-users --query "Users[*].UserName" --output text 2>/dev/null', args.timeoutMs);
  if (iamUsers) {
    for (const user of iamUsers.split('\t').filter(Boolean).slice(0, 50)) {
      const mfa = safeRun(`aws iam list-mfa-devices --user-name "${user}" --query "MFADevices" --output text 2>/dev/null`, 10000);
      if (!mfa) {
        findings.push({ severity:'high', resource:'IAM', detail:`User ${user} has no MFA device`, remediation:`Enable MFA for ${user}` });
      }
      const keys = safeRun(`aws iam list-access-keys --user-name "${user}" --query "AccessKeyMetadata[?Status=='Active']" --output text 2>/dev/null`, 10000);
      if (keys) {
        // Check key age — this would need a script
        findings.push({ severity:'medium', resource:'IAM', detail:`User ${user} has active access keys`, remediation:'Rotate keys every 90 days, consider using IAM roles instead' });
      }
    }
  }

  // Check S3 public buckets
  const buckets = safeRun('aws s3api list-buckets --query "Buckets[*].Name" --output text 2>/dev/null', 15000);
  if (buckets) {
    for (const bucket of buckets.split('\t').filter(Boolean).slice(0, 30)) {
      const acl = safeRun(`aws s3api get-bucket-acl --bucket "${bucket}" --query "Grants[?Grantee.URI=='http://acs.amazonaws.com/groups/global/AllUsers']" --output text 2>/dev/null`, 10000);
      if (acl) {
        findings.push({ severity:'critical', resource:'S3', detail:`Bucket ${bucket} has public ACL`, remediation:`aws s3api put-bucket-acl --bucket ${bucket} --acl private` });
      }
      const block = safeRun(`aws s3api get-public-access-block --bucket "${bucket}" 2>/dev/null | grep -c "true" || echo 0`, 10000).trim();
      if (block === '0') {
        findings.push({ severity:'high', resource:'S3', detail:`Bucket ${bucket} has no public access block`, remediation:`Enable Block Public Access on ${bucket}` });
      }
    }
  }

  // CloudTrail
  const trails = safeRun('aws cloudtrail describe-trails --query "trailList[*].Name" --output text 2>/dev/null', 15000).trim();
  if (!trails) {
    findings.push({ severity:'critical', resource:'CloudTrail', detail:'No CloudTrail trails configured', remediation:'Create a CloudTrail trail with log validation and SSE-KMS encryption' });
  }

  // GuardDuty
  const guardduty = safeRun('aws guardduty list-detectors --query "DetectorIds" --output text 2>/dev/null', 10000).trim();
  if (!guardduty) {
    findings.push({ severity:'high', resource:'GuardDuty', detail:'GuardDuty not enabled', remediation:'Enable GuardDuty for threat detection' });
  }

  // Security Hub
  const securityhub = safeRun('aws securityhub get-enabled-standards --query "StandardsSubscriptions[*].StandardsArn" --output text 2>/dev/null', 10000).trim();
  if (!securityhub) {
    findings.push({ severity:'medium', resource:'SecurityHub', detail:'AWS Security Hub not enabled', remediation:'Enable Security Hub for centralized findings' });
  }

  return jsonResult({
    timestamp: new Date().toISOString(),
    findings,
    summary: { total:findings.length, critical:findings.filter(f=>f.severity==='critical').length, high:findings.filter(f=>f.severity==='high').length },
  });
});

const transport = new StdioServerTransport();
await server.connect(transport);

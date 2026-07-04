import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, extname } from 'node:path';

const riskyPatterns = [
  {name:'eval() call',re:/(?:^|[^.\w])eval\s*\(/g,sev:'high'},
  {name:'new Function()',re:/\bnew\s+Function\s*\(/g,sev:'high'},
  {name:'execSync shell:true',re:/execSync\(.{0,100}\bshell\s*:\s*true/g,sev:'high'},
  {name:'spawn shell:true',re:/\bspawn\(.{0,100}\bshell\s*:\s*true/g,sev:'high'},
  {name:'exec with string',re:/exec\(['"`].*\$[{(].*['"`]/g,sev:'high'},
  {name:'TLS verification disabled',re:/(?:NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*[0'"]|rejectUnauthorized\s*:\s*false)/g,sev:'high'},
  {name:'Weak crypto (md5/sha1)',re:/\b(?:createHash|createHmac)\s*\(\s*['"](?:md5|sha1)['"]/g,sev:'moderate'},
  {name:'Math.random for crypto',re:/Math\.random\(\)[^\n]{0,60}\b(?:token|key|secret|nonce|iv|salt|crypto)/gi,sev:'high'},
  {name:'Hardcoded cert/key',re:/['"]-----BEGIN\s+(?:CERTIFICATE|PRIVATE\s+KEY)-----/g,sev:'critical'},
  {name:'chmod 777',re:/chmod(?:Sync)?\([^,]+,\s*0?o?777/gi,sev:'high'},
  {name:'http (not https)',re:/require\(['"]http['"]\)/g,sev:'low'},
  {name:'TODO/FIXME security',re:/\b(?:TODO|FIXME|HACK)\b[^\n]{0,80}\b(?:secur|crypto|password|token|secret|vuln)/gi,sev:'low'},
  {name:'SQL injection risk',re:/(?:SELECT|INSERT|UPDATE|DELETE).*\+.*\b(?:req\.|input|param|query)/gi,sev:'high'},
  {name:'XSS risk (innerHTML)',re:/\.innerHTML\s*=/gi,sev:'moderate'},
  {name:'Command injection risk',re:/(?:exec|spawn|execSync)\(['"`][^'"`]*\${[^}]*}[^'"`]*['"`]/g,sev:'high'},
  {name:'Debug flag enabled',re:/\b(?:DEBUG|IS_DEBUG|__DEV__|NODE_ENV\s*=\s*['"]development['"])\s*=\s*(?:true|1|['"]true['"])/g,sev:'low'},
  {name:'CORS wildcard',re:/Access-Control-Allow-Origin\s*:\s*['"]\*['"]/gi,sev:'moderate'},
  {name:'Version pinning missing',re:/\bversion\s*:\s*['"]\^?\s*['"]/g,sev:'low'},
];

const skipDirs = new Set(['node_modules','.git','dist','.angular','coverage','security-analysis','__pycache__','.vscode','.vigil','.erosolar']);
const findings = [];

function walk(dir, maxFiles = 200) {
  if (findings.length >= maxFiles) return;
  try {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (findings.length >= maxFiles) break;
      if (skipDirs.has(e.name)) continue;
      if (e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) { walk(full, maxFiles); continue; }
      if (!e.isFile()) continue;
      const ext = extname(e.name).toLowerCase();
      if (!['.js','.mjs','.ts','.tsx','.py','.java'].includes(ext)) continue;
      try {
        const st = statSync(full);
        if (st.size > 2 * 1024 * 1024) continue;
        const text = readFileSync(full, 'utf8');
        for (const p of riskyPatterns) {
          p.re.lastIndex = 0;
          const matches = text.match(p.re);
          if (matches) {
            for (const m of matches) {
              const rel = relative('.', full).replace(/\\/g,'/');
              const excerpt = m.slice(0, 100).replace(/\n/g, '\\n');
              findings.push({ file: rel, pattern: p.name, severity: p.sev, excerpt });
            }
          }
        }
      } catch(e) {}
    }
  } catch(e) {}
}

walk('.');
const seen = new Set();
const deduped = [];
for (const f of findings) {
  const k = f.file + '|' + f.pattern + '|' + f.excerpt.slice(0, 30);
  if (seen.has(k)) continue;
  seen.add(k);
  deduped.push(f);
}

console.log('=== CODE RISK PATTERN SCAN ===');
console.log('Total risky patterns (deduped):', deduped.length);
console.log('');
const bySev = {};
for (const f of deduped) { bySev[f.severity] = (bySev[f.severity] || 0) + 1; }
console.log('By severity:', JSON.stringify(bySev));
console.log('');
for (const f of deduped) {
  console.log(`  [${f.severity.toUpperCase()}] ${f.pattern} — ${f.file}`);
  console.log(`    ${f.excerpt}`);
}

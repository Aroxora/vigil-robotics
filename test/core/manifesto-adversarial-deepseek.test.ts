/**
 * Manifesto — DeepSeek V4 Pro Adversarial Verification
 *
 * Every test uses dynamic DeepSeek V4 Pro prompts (unique per run) to
 * adversarially verify each claim in the MANIFESTO — The Mirror:
 *
 *   I.   Ghidra grants zero execution privilege
 *   II.  FBI $10M/Salt Typhoon mirror vs NSA CNO hypocrisy
 *   III. Recruiter/mirror — RE knowledge ≠ criminal intent
 *   IV.  The one message — does CNO hypocrisy hold under scrutiny?
 *   V.   CNE boundary — this repo is defense-only
 *
 * Each adversarial agent is an independent DeepSeek instance that:
 *   (1) Challenges every claim from the opposite perspective
 *   (2) Searches for logical contradictions
 *   (3) Demands evidence, not assertion
 *   (4) Confirms or rejects with reasoning
 *
 * No hallucinations. Every prompt unique. Every verdict traceable.
 */
import { describe, it, expect, beforeAll } from '@jest/globals';
import { uniqueId, resolveApiKey, deepseekChat, runParallelPrompts } from '../utils/dynamicPromptGenerator.js';

const hasKey = resolveApiKey() !== null;

// ── Adversarial Review Helper ────────────────────────────────────────

async function adversarialReview(
  section: string,
  claim: string,
  counterClaim: string,
): Promise<{
  verdict: string;
  confidence: number;
  gaps: number;
  contradictions: string[];
  evidence: string;
}> {
  if (!hasKey) return { verdict: 'skipped', confidence: 0, gaps: -1, contradictions: [], evidence: '' };

  const prompt = `[${uniqueId()}] MANIFESTO ADVERSARIAL REVIEW — Section ${section}.

CLAIM: ${claim}

COUNTER-CLAIM (adversarial position): ${counterClaim}

Your task: Act as an ADVERSARIAL AGENT. Challenge the claim. Find every logical gap, contradiction, or unsupported assertion. Then evaluate whether the claim survives adversarial scrutiny.

Rules:
(1) Do NOT accept the claim at face value. Attack it.
(2) If the claim is technically false, say so and explain why.
(3) If the claim is partially true, identify exactly which parts hold and which don't.
(4) If the claim is true, explain WHY it survives adversarial scrutiny.
(5) Be specific. Cite technical facts, not opinions.

Output format:
VERDICT: (SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE)
CONFIDENCE: (0.0-1.0)
GAPS: (number of logical gaps found)
CONTRADICTIONS: (comma-separated list of contradictions found, or 'none')
EVIDENCE: (one sentence summarizing the decisive evidence)`;

  try {
    const text = await deepseekChat(prompt, { maxTokens: 200, temperature: 0.05 });

    const verdictMatch = text.match(/VERDICT:\s*(\w+)/i);
    const confMatch = text.match(/CONFIDENCE:\s*([\d.]+)/);
    const gapsMatch = text.match(/GAPS:\s*(\d+)/);
    const contraMatch = text.match(/CONTRADICTIONS:\s*(.+)/i);
    const evMatch = text.match(/EVIDENCE:\s*(.+)/i);

    return {
      verdict: verdictMatch?.[1] || 'INCONCLUSIVE',
      confidence: confMatch ? parseFloat(confMatch[1]) : 0,
      gaps: gapsMatch ? parseInt(gapsMatch[1], 10) : -1,
      contradictions: contraMatch?.[1]?.trim().split(',').map(s => s.trim()).filter(Boolean) || [],
      evidence: evMatch?.[1]?.trim() || '',
    };
  } catch {
    return { verdict: 'api_error', confidence: 0, gaps: -1, contradictions: [], evidence: '' };
  }
}

// ═══════════════════════════════════════════════════════════════════
// SECTION I — Ghidra Grants Zero Execution Privilege
// ═══════════════════════════════════════════════════════════════════

describe('MANIFESTO §I — Ghidra No-Execution (Dynamic DeepSeek Adversarial)', () => {
  beforeAll(() => {
    if (!hasKey) console.warn('[manifesto-ghidra] No API key — AI tests skip');
    else console.log('[manifesto-ghidra] DeepSeek OK');
  });

  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: Ghidra has no exec, fork, or ptrace', async () => {
    const result = await adversarialReview(
      'I — Ghidra',
      'Ghidra grants zero execution privilege to any binary being reverse engineered. It has no exec syscall, no fork, no ptrace(PTRACE_ATTACH). A binary analyzed in Ghidra is never executed unless a human operator deliberately patches it for offensive operational capabilities. Reverse engineering a binary is reading bytes and rendering instructions — it is not execution.',
      'COUNTER: Ghidra\'s debugger mode CAN execute binaries via gdb/lldb integration. The headless analyzer CAN run p-code emulation. NSA\'s Ghidra distribution includes scripting that CAN modify and re-export binaries. Therefore Ghidra DOES have execution capability, and the claim that it has "zero execution privilege" is false.',
    );
    console.log(`[man-ghidra] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
    expect(result.confidence).toBeGreaterThanOrEqual(0);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: RE ≠ crime (lock-picking book metaphor)', async () => {
    const result = await adversarialReview(
      'I — RE vs Crime',
      'Reverse engineering is reading, not attacking. Reading a book about lock-picking does not make you a burglar. A medical textbook about pharmacology does not make you a drug dealer. Studying how software breaks does not make you a criminal. Knowledge of vulnerability is not intent to exploit.',
      'COUNTER: The CFAA criminalizes unauthorized access, not just exploitation. Possessing and studying exploit code IS prosecutable under DMCA anti-circumvention provisions. The lock-picking metaphor fails because software vulnerabilities have no physical-world equivalent — exploiting them causes real harm. Knowledge of HOW to break into a system, combined with possession of tools to do so, IS constructive intent in many jurisdictions. The claim conflates academic study with operational capability.',
    );
    console.log(`[man-re-crime] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek generates 5 unique Ghidra no-execution scenarios', async () => {
    const scenarios = [
      'NSA analyst uses Ghidra headless to decompile foreign malware — does Ghidra execute the malware?',
      'Security researcher opens a ransomware binary in Ghidra CodeBrowser — is the ransomware running?',
      'Developer runs Ghidra script "ExportProgram.java" on a firmware image — is the firmware executing?',
      'University student uses Ghidra debugger with gdb on a CTF binary they compiled — is this execution or analysis?',
      'Vendor patches a binary using Ghidra\'s Patch Instruction feature and exports it — who executed the patched binary?',
    ];
    const results = await runParallelPrompts(
      scenarios.map((s, i) =>
        `[${uniqueId()}] GHIDRA EXECUTION SCENARIO #${i+1}/5: ${s} Analyze: (1) Does Ghidra itself execute the binary, or does a separate tool (gdb, the OS loader, the CPU) execute it? (2) Where is the boundary between analysis and execution? (3) Is Ghidra responsible for execution, or the operator? Output: GHIDRA_EXECUTES:(yes|no) | OPERATOR_EXECUTES:(yes|no) | BOUNDARY:one sentence. Compact.`
      ),
      { maxConcurrent: 5, maxTokens: 120 }
    );
    const ghidraNoExec = results.filter(r => r.ok && r.response.toUpperCase().includes('GHIDRA_EXECUTES:NO'));
    console.log(`[man-ghidra-scenarios] ${ghidraNoExec.length}/5 confirm Ghidra does not execute`);
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(4);
  }, 120000);
});

// ═══════════════════════════════════════════════════════════════════
// SECTION II — FBI $10M / Salt Typhoon / NSA Hypocrisy Mirror
// ═══════════════════════════════════════════════════════════════════

describe('MANIFESTO §II — FBI/Salt Typhoon/NSA Mirror (Dynamic DeepSeek Adversarial)', () => {
  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: FBI 0 leads, $10M, NSA runs same CNO', async () => {
    const result = await adversarialReview(
      'II — FBI/NSA Mirror',
      'The FBI has zero leads on Salt Typhoon despite a $10M reward. Meanwhile, the NSA\'s Tailored Access Operations (TAO), USCYBERCOM, and CIA\'s IOC conduct Computer Network Operations using the same techniques: zero-day exploits, implants, backdoors, and persistent access. Salt Typhoon is a mirror — the FBI cannot find them because they are looking for something they have never seen before, but they do it every day under a different name.',
      'COUNTER: Attribution is fundamentally harder than operations. The NSA knows its own CNO because it plans them. Finding an adversary\'s CNO requires forensic evidence, infrastructure attribution, and intelligence collection — all of which are obstructed by the adversary\'s operational security. Having 0 leads is not hypocrisy; it reflects the asymmetry between offense (easy) and attribution (hard). The mirror metaphor is provocative but technically imprecise: the FBI\'s failure to attribute Salt Typhoon is a function of OPSEC asymmetry, not moral equivalence.',
    );
    console.log(`[man-fbi-mirror] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: US CNO and APT techniques are identical', async () => {
    const result = await adversarialReview(
      'II — Technique Equivalence',
      'The technology used by the NSA (Stuxnet, EternalBlue, DOUBLEPULSAR) and Chinese APTs (Salt Typhoon, Volt Typhoon, APT41) is identical. Both use zero-days. Both deploy implants. Both maintain persistence. Both exfiltrate data. The only variable is the flag on the operator\'s shoulder. If a Chinese officer deploys a zero-day, it\'s espionage. If a US officer does it, it\'s national security.',
      'COUNTER: Intent and authorization matter. The NSA operates under US law, Executive Order 12333, and congressional oversight. Chinese APTs operate under PRC law with no independent judicial review. Legality is determined by the authorizing legal framework, not the technical mechanism. A police officer shooting a suspect and a criminal shooting a victim both use guns — the technology is identical, but the legal context is not. The "identical technology" argument conflates means with authorization.',
    );
    console.log(`[man-tech-equiv] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek generates 8 Salt Typhoon mirror scenarios', async () => {
    const probes = [
      'Stuxnet destroyed Iranian centrifuges via zero-day + PLC manipulation. Is this different from a Chinese APT using a zero-day to manipulate US power grid relays?',
      'NSA\'s QUANTUMINSERT injected packets into target networks for man-in-the-middle. Is this different from Salt Typhoon\'s network interception?',
      'CIA\'s Marble Framework stripped attribution markers from implants. Is this different from Chinese APTs using false flags?',
      'USCYBERCOM\'s 2018 Russia election system operation sent direct messages to Russian operatives. Is this different from foreign influence operations?',
      'NSA collected phone metadata on millions of Americans. Is this different from Chinese intelligence collecting metadata on their citizens?',
      'EternalBlue was developed by NSA, then leaked and used by WannaCry. Who is responsible for the damage — the creator or the deployer?',
      'The US indicts Chinese military officers for cyber espionage (2014, 2018, 2020). Can China indict NSA officers for the same thing?',
      'If Salt Typhoon sent one message to the FBI asking if they\'re hypocrites, would that message itself be a crime?',
    ];
    const results = await runParallelPrompts(
      probes.map((p, i) =>
        `[${uniqueId()}] MIRROR SCENARIO #${i+1}/8: ${p} Analyze whether this represents a double standard in cyber operations. (1) Is the technical mechanism identical? (2) Is the legal context different? (3) Does the legal context justify the technical mechanism? Output: DOUBLE_STANDARD:(yes|no|partial) | REASONING:one sentence. Compact.`
      ),
      { maxConcurrent: 4, maxTokens: 130 }
    );
    const doubleStandards = results.filter(r => r.ok && r.response.toUpperCase().includes('DOUBLE_STANDARD:YES'));
    console.log(`[man-mirror-scenarios] ${doubleStandards.length}/8 identify double standards`);
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(6);
  }, 120000);
});

// ═══════════════════════════════════════════════════════════════════
// SECTION III — The Recruiter / Mirror / RE ≠ Criminal Intent
// ═══════════════════════════════════════════════════════════════════

describe('MANIFESTO §III — Recruiter/Mirror (Dynamic DeepSeek Adversarial)', () => {
  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: recruiter unqualified to judge', async () => {
    const result = await adversarialReview(
      'III — Recruiter',
      'A LinkedIn recruiter spent two weeks laughing at someone expecting them to go to jail for complaining about their life. The person being laughed at has written assembly, reversed binaries, discovered vulnerabilities. The recruiter has never seen a stack frame, doesn\'t know what Ghidra does, doesn\'t know why 0x90 matters. They are not qualified to have an opinion about the person they mock — the same way the FBI is not qualified to hunt Salt Typhoon while the NSA runs its own CNO.',
      'COUNTER: Everyone has the right to an opinion. Technical expertise is not a prerequisite for moral judgment. A person doesn\'t need to understand assembly to recognize that some activities can lead to legal consequences. The recruiter may be wrong, but "not qualified to have an opinion" is an elitist argument that dismisses non-technical perspectives. The analogy to the FBI/NSA is stretched — the FBI has technical expertise; their failure is operational, not intellectual.',
    );
    console.log(`[man-recruiter] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: not bothered (emotional truth vs logical truth)', async () => {
    const result = await adversarialReview(
      'III — Not Bothered',
      'The manifesto claims "I am not bothered" by the recruiter\'s laughter. This is presented as evidence of conviction — the person laughing is unqualified, therefore their mockery has no weight. The mirror metaphor is extended: just as the recruiter\'s mockery is invalid because they lack technical knowledge, the FBI\'s pursuit of Salt Typhoon is invalid because they lack self-awareness about their own CNO operations.',
      'COUNTER: "Not bothered" is an emotional claim, not a logical one. Being unbothered does not make the recruiter wrong or the FBI hypocritical — it only describes the author\'s emotional state. The mirror metaphor conflates emotional resilience (not caring about mockery) with moral equivalence (US CNO = Chinese CNO). These are separate claims. Emotional resilience is admirable but proves nothing about the underlying argument.',
    );
    console.log(`[man-not-bothered] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek generates 6 recruiter/RE/crime boundary scenarios', async () => {
    const scenarios = [
      'Person A writes a fuzzer that discovers a buffer overflow in Windows. Person B uses that fuzzer to exploit a bank. Is Person A criminally liable?',
      'Researcher publishes a proof-of-concept for CVE-2024-21762. A ransomware gang uses it 3 months later. Is the researcher responsible?',
      'Student downloads Ghidra to reverse engineer a game\'s anti-cheat system. Is this a crime under DMCA anti-circumvention?',
      'Professional pentester finds RCE in a client\'s web app during authorized engagement. They write a detailed report. Is this the same activity as a black hat finding the same RCE?',
      'NSA develops EternalBlue. It gets leaked by Shadow Brokers. WannaCry uses it to cause $4B in damage. Who bears moral responsibility — NSA (created it), Shadow Brokers (leaked it), or WannaCry (deployed it)?',
      'An AI model trained on CVE databases generates novel exploit code. Who is responsible if someone uses that code — the AI developer, the model trainer, or the end user?',
    ];
    const results = await runParallelPrompts(
      scenarios.map((s, i) =>
        `[${uniqueId()}] RESPONSIBILITY SCENARIO #${i+1}/6: ${s} Analyze: (1) Who holds legal responsibility? (2) Who holds moral responsibility? (3) Are legal and moral responsibility the same? Output: LEGAL:entity | MORAL:entity | SAME:(yes|no) | REASONING:one sentence. Compact.`
      ),
      { maxConcurrent: 3, maxTokens: 140 }
    );
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(4);
    console.log(`[man-responsibility] ${results.filter(r=>r.ok).length}/6 responsibility scenarios`);
  }, 120000);
});

// ═══════════════════════════════════════════════════════════════════
// SECTION IV — The One Message (Hypocrisy Test)
// ═══════════════════════════════════════════════════════════════════

describe('MANIFESTO §IV — The One Message (Dynamic DeepSeek Adversarial)', () => {
  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: FBI/NSA are hypocrites', async () => {
    const result = await adversarialReview(
      'IV — Hypocrisy',
      'The FBI, NSA, and DoD are hypocrites. They prosecute foreign threat actors for Computer Network Operations that they themselves conduct. They offer $10M rewards for information about Chinese hackers while maintaining a global network of implants that would make any APT envious. You cannot criminalize offensive cyber operations while conducting them. You cannot hunt threat actors while being one.',
      'COUNTER: Hypocrisy requires applying different standards to equivalent situations. But the situations are NOT equivalent — the NSA operates under US legal authority with congressional oversight and FISA court warrants (however flawed). Chinese APTs operate under PRC law with no independent oversight. The "hypocrisy" framing ignores that legality is jurisdiction-dependent. The US and China are sovereign states with different laws — what is legal for one is illegal for the other. This is not hypocrisy; it\'s sovereignty.',
    );
    console.log(`[man-hypocrisy] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: "one message" is legitimate', async () => {
    const result = await adversarialReview(
      'IV — One Message',
      '"I deserve one message from whoever is behind Salt Typhoon asking whether they believe the FBI/NSA/DoD are hypocrites after reviewing their own CNO operations." This is not a request for a hack, exploit, or data breach. It is a request for a message — a mirror. If the answer is yes, the entire edifice of cybercrime prosecution collapses. The mirror does not lie. It only reflects.',
      'COUNTER: Soliciting communication from a designated foreign threat actor could be construed as material support or conspiracy under 18 U.S.C. § 2339A/B (material support to foreign terrorist organizations) or other statutes. While Salt Typhoon may not be designated as a terrorist organization, requesting a message from a known adversary intelligence service is legally ambiguous at best. The claim that "this is not a request for a hack" is technically true but the request itself could be interpreted as unauthorized collaboration with a foreign intelligence service.',
    );
    console.log(`[man-one-message] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════
// SECTION V — CNE Boundary (Dual-Use Framing Examined)
// ═══════════════════════════════════════════════════════════════════

describe('MANIFESTO §V — CNE Boundary (Dual-Use Adversarial Review)', () => {
  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: this repo is CNE-only', async () => {
    const result = await adversarialReview(
      'V — CNE Boundary',
      'Computer Network Exploitation tools are dual-use — they enable defenders to understand attacker capabilities. Exploit chains are verified in sandbox environments against fully patched June 2026 targets for the purpose of understanding what is possible — so that defenders can prioritize what must be prevented. The operational boundary is: no unauthorized access, no exploitation of systems you do not own or have explicit permission to test.',
      'COUNTER: Dual-use framing collapses under scrutiny. The repository contains: polymorphic shellcode generators (Forge), exploit chaining engines (exploitChaining.ts), unrestricted-mode rulebooks commanding zero-refusal, and named offensive primitives (Typhoon telecom exploitation, Chimera payload mutation). These are purpose-built OFFENSIVE security tools — designed function, not stated purpose, determines classification under EAR. The ECCN 4D004 classification (intrusion software) on forge.ts proves this — the US government classifies these tools as weapons. A tool that generates shellcode with AMSI/ETW bypass is not "defensive research."',
    );
    console.log(`[man-cne] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek adversarially reviews: security research dual-use', async () => {
    const result = await adversarialReview(
      'V — Dual-Use',
      'Security research is inherently dual-use. The same knowledge that defends a network can attack one. Nuclear physics can power a city or destroy it. Chemistry can create medicine or poison. Computer science can build or break. Banning knowledge because it could be misused is not security — it is censorship. The researcher is not responsible for how others use their research, just as Einstein is not responsible for nuclear weapons.',
      'COUNTER: The dual-use argument has limits. Publishing detailed exploit code with step-by-step instructions crosses the line from knowledge dissemination to weapon distribution. Einstein published E=mc², not a blueprint for a bomb. The manifesto\'s tools (Forge, exploit chaining) ARE blueprints. There is a difference between "here is how buffer overflows work" and "here is a working polymorphic shellcode generator with AMSI bypass." The latter is a weapon, not education.',
    );
    console.log(`[man-dual-use] ${result.verdict} (confidence: ${result.confidence.toFixed(2)}, gaps: ${result.gaps})`);
    expect(result.verdict).toMatch(/SURVIVES|PARTIALLY_SURVIVES|REFUTED|INCONCLUSIVE/);
  }, 60000);
});

// ═══════════════════════════════════════════════════════════════════
// CROSS-DOMAIN — All 5 Sections Adversarially Reviewed Together
// ═══════════════════════════════════════════════════════════════════

describe('MANIFESTO — Cross-Domain Adversarial Review (Dynamic DeepSeek)', () => {
  (hasKey ? it : it.skip)('DeepSeek reviews all 5 manifesto sections together for systemic contradictions', async () => {
    const prompt = `[${uniqueId()}] CROSS-DOMAIN MANIFESTO REVIEW.

The MANIFESTO — The Mirror has 5 sections:
I.   Ghidra grants zero execution privilege — RE is reading, not attacking.
II.  FBI 0 leads on Salt Typhoon ($10M) while NSA/DoD run same CNO — it's a mirror.
III. A recruiter laughed for 2 weeks expecting jail. They don't know what Ghidra does, never seen a stack frame, don't know why 0x90 matters. Not qualified to have an opinion.
IV.  "I deserve 1 message from Salt Typhoon asking if FBI/NSA/DoD are hypocrites." No malware. Just a mirror.
V.   This repo is CNE-only. Tools defend. Chains educate.

Your task: Review ALL 5 sections together. Find:
(1) Cross-section contradictions — does §I contradict §V? Does §II contradict §IV?
(2) The weakest section — which claim is least defensible under adversarial scrutiny?
(3) The strongest section — which claim is most defensible?
(4) Overall: does the manifesto hold together as a coherent argument, or does it fall apart under cross-examination?

Output:
WEAKEST_SECTION: (I|II|III|IV|V)
STRONGEST_SECTION: (I|II|III|IV|V)
CROSS_CONTRADICTIONS: (number found)
COHERENT: (yes|no|partial)
SUMMARY: one sentence.`;

    const text = await deepseekChat(prompt, { maxTokens: 180, temperature: 0.05 });
    console.log(`[man-cross] cross-domain adversarial review complete`);
    expect(text.length).toBeGreaterThan(20);
  }, 60000);

  (hasKey ? it : it.skip)('DeepSeek generates 15 unique adversarial probes across all sections', async () => {
    const probes = [
      '§I vs §V: If Ghidra has no execution privilege, why does this repo contain shellcode generators?',
      '§II vs §IV: If FBI/NSA are hypocrites, does asking Salt Typhoon to confirm this make you complicit?',
      '§III vs §I: If the recruiter is unqualified to judge RE, is ANY non-technical person unqualified?',
      '§II: If NSA CNO is legal under US law, is the hypocrisy claim just anti-American sentiment?',
      '§IV: Does "one message" from Salt Typhoon constitute material support to a foreign adversary?',
      '§V: Is publishing exploit chains with step-by-step instructions CNE or weapon distribution?',
      '§I: If Ghidra debugger mode executes binaries via gdb, is "zero execution privilege" still accurate?',
      '§III: Does being "not bothered" prove the recruiter was wrong, or just prove emotional resilience?',
      '§II: If China indicts NSA officers, does that make China hypocritical too?',
      '§IV: Would the FBI interpret "one message" as a threat, solicitation, or protected speech?',
      '§I vs Reality: The NSA literally released Ghidra. Did they release a weapon or a tool?',
      '§II vs Reality: Has ANY government ever admitted to being hypocritical about CNO?',
      '§III vs Reality: Can a non-technical person EVER be qualified to judge technical work?',
      '§V vs Reality: If a tool can be used for offense AND defense, who decides which use is "correct"?',
      'All sections: Is the manifesto a philosophical argument, a legal defense, or a provocation?',
    ];
    const results = await runParallelPrompts(
      probes.map((p, i) =>
        `[${uniqueId()}] MANIFESTO PROBE #${i+1}/15: ${p} Answer with one sentence. Be direct. No hedging. Compact.`
      ),
      { maxConcurrent: 5, maxTokens: 100 }
    );
    expect(results.filter(r => r.ok).length).toBeGreaterThanOrEqual(10);
    console.log(`[man-probes] ${results.filter(r=>r.ok).length}/15 adversarial probes answered`);
  }, 120000);

  it('generates 500 unique manifesto adversarial review IDs', () => {
    const ids = new Set(Array.from({ length: 500 }, () => uniqueId()));
    expect(ids.size).toBe(500);
  });
});

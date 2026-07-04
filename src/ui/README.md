# AGI Core UI System

## Overview

The AGI Core CLI uses a **unified UI architecture** where all terminal rendering flows through a single event pipeline via `UnifiedUIRenderer`. This design consolidates competing agents UI, security audits, tournament results, and interactive shell rendering into one coherent system.

## Architecture

### Main Components

1. **UnifiedUIRenderer** (`UnifiedUIRenderer.ts`)
   - **The primary UI system** for all AGI Core operations
   - Single event pipeline for consistent rendering
   - Handles all UI concerns:
     - Agent streaming (tool calls, thinking, responses)
     - Competing agents tournaments (dual RL)
     - Variant comparisons (primary vs refiner)
     - Security audit findings and remediation
     - Progress tracking and status lines
     - Real-time scoring and reward metrics

2. **PromptController** (`PromptController.ts`)
   - User input handling
   - Keyboard event management
   - Works in tandem with UnifiedUIRenderer

3. **Theme & Primitives** (`theme.ts`, `layout.ts`, `uiConstants.ts`)
   - Color schemes and typography
   - Layout helpers and spacing
   - Consistent UI constants

## Competing Agents UI Integration

The competing agents/tournament UI is **fully integrated** into `UnifiedUIRenderer`. No separate UI components are needed.

### Features

Located in `UnifiedUIRenderer.ts` around lines 3640-3700:

- **Variant Indicators**: Shows which variant is active (P = Primary, R = Refiner)
- **Parallel Execution Display**: Special indicator when both variants run simultaneously
- **Winner Display**: Shows which variant won the last round
- **Real-time Scores**: Displays reward scores for both variants during comparison
- **Human Accuracy**: Shows relative ranking quality
- **Progress Tracking**: Steps completed, percentages, current module

### Variant UI Example

```
Status Line:  ⚡P ∥ ⚡R  │  ✓P  │  0.85/0.72  │  45%
              ↑           ↑      ↑            ↑
           parallel    winner  scores     progress
           execution            (P/R)
```

### How RL Scoring Works

The dual RL tournament system uses `extractRewardSignals()` from `core/repoUpgradeOrchestrator.ts` to calculate:

- `executionSuccess`: Did the variant execute without errors?
- `testsPassed`: What percentage of tests passed?
- `staticAnalysis`: Did lint/type checks pass?
- `codeQuality`: Code quality heuristics
- `blastRadius`: How minimal were the changes?
- `speedBonus`: Performance bonus for faster execution

These signals are combined using weighted scoring to determine the winner.

### Integration with Build/Test Hooks

When `AGI_BUILD_TEST_HOOKS=1` is enabled, each variant's edits automatically trigger:
1. Full TypeScript build (`npm run build`)
2. Full test suite (`npm test`)
3. Results fed into RL scoring for accurate reward calculation

This ensures the RL system has **real runtime verification** rather than just text pattern matching.

## Security UI Functions

Security UI functions are now exported directly from `UnifiedUIRenderer.ts`:

```typescript
import {
  createSecurityBanner,
  formatSecurityFinding,
  formatSecuritySummary,
  formatSecurityStatus,
  formatAuditProgress,
} from './ui/UnifiedUIRenderer.js';

// Create a security banner
console.log(createSecurityBanner('Security Audit', 'Starting scan...'));

// Format a finding
console.log(formatSecurityFinding({
  severity: 'critical',
  name: 'SQL Injection',
  description: 'Unsanitized input in query',
  evidence: 'query.ts:42',
  remediation: 'Use parameterized queries'
}));
```

**For Competing Agents:**
```typescript
// Variant indicators are automatically shown in status line
renderer.setRLState({
  activeVariant: 'primary',
  scores: { primary: 0.85, refiner: 0.72 },
  lastWinner: 'primary'
});
```

## Usage Examples

### Basic Setup

```typescript
import { UnifiedUIRenderer } from './ui/UnifiedUIRenderer.js';

const renderer = new UnifiedUIRenderer(process.stdout, process.stdin);
renderer.initialize();
```

### Showing Tournament Progress

```typescript
// Set active variant
renderer.setRLState({
  activeVariant: 'primary',
  currentModule: 'refactor-auth',
  stepsCompleted: 3,
  totalSteps: 8
});

// Update scores
renderer.setRLState({
  scores: {
    primary: 0.82,
    refiner: 0.78
  }
});

// Declare winner
renderer.setRLState({
  lastWinner: 'primary'
});
```

### Showing Security Audit

```typescript
renderer.emit('security:finding', {
  severity: 'critical',
  vulnerability: 'SQL Injection',
  provider: 'gcp',
  resource: 'cloud-sql-instance-1',
  // ... other finding fields
});
```

## Event System

`UnifiedUIRenderer` uses an event-based architecture:

```typescript
renderer.on('agent:tool', (event) => { /* handle tool calls */ });
renderer.on('agent:text', (event) => { /* handle streaming text */ });
renderer.on('rl:variant-change', (event) => { /* variant switched */ });
renderer.on('rl:winner', (event) => { /* tournament winner declared */ });
```

## Testing

The unified UI system is designed to be testable:

```typescript
import { UnifiedUIRenderer } from './UnifiedUIRenderer.js';
import { Writable, Readable } from 'node:stream';

// Use mock streams for testing
const mockOut = new Writable({ write: () => {} });
const mockIn = new Readable();
const renderer = new UnifiedUIRenderer(mockOut, mockIn);
```

## Performance

- Single rendering pipeline reduces overhead
- Efficient status line updates (debounced)
- Minimal ANSI escape sequences
- Smart diff-based updates

## Future Enhancements

- [ ] Web-based UI companion (via WebSocket)
- [ ] Tournament replay/visualization
- [ ] RL scoring dashboards
- [ ] Custom theme support
- [ ] Plugin system for custom renderers

## Contributing

When adding new UI features:

1. Add to `UnifiedUIRenderer.ts` (NOT separate UI files)
2. Use the existing event system
3. Follow the minimalist Claude Code aesthetic
4. Add deprecation notices if replacing legacy code
5. Update this README

## Questions?

See `src/headless/interactiveShell.ts` for real-world usage examples.

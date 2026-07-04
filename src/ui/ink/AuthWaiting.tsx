/**
 * AuthWaiting — Ink-rendered first-launch sign-in flow.
 *
 * Replaces the chalk + console.log dance in src/core/auth.ts with a
 * single live status panel: spinner while waiting for the browser
 * callback, URL-fallback line if the browser didn't auto-open, and a
 * success row that flips green when the callback lands.
 */
import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import Spinner from 'ink-spinner';

export type AuthStatus = 'waiting' | 'success' | 'error';

export interface AuthState {
  status: AuthStatus;
  loginUrl?: string | null;
  email?: string | null;
  uid?: string | null;
  errorMessage?: string | null;
  /** When true, the caller couldn't auto-open the browser; show the URL fallback. */
  showFallbackUrl?: boolean;
}

export interface AuthWaitingHandle {
  setState: (next: AuthState) => void;
}

export function AuthWaiting({ register }: { register: (handle: AuthWaitingHandle) => void }) {
  const [state, setState] = useState<AuthState>({ status: 'waiting' });

  useEffect(() => {
    register({ setState });
  }, [register]);

  return (
    <Box flexDirection="column" paddingX={1} paddingY={1}>
      <Box>
        <Text color="yellow">▣ </Text>
        <Text color="yellow" bold>Authentication required to use Vigil.</Text>
      </Box>
      {state.status === 'waiting' && (
        <Box marginTop={1}>
          <Text color="cyan"><Spinner type="dots" /></Text>
          <Text color="#8B95A5"> Waiting for browser login…</Text>
        </Box>
      )}
      {state.status === 'success' && (
        <Box marginTop={1}>
          <Text color="green">✓ </Text>
          <Text color="green">Signed in as {state.email || state.uid}</Text>
        </Box>
      )}
      {state.status === 'error' && (
        <Box marginTop={1}>
          <Text color="red">✗ </Text>
          <Text color="red">{state.errorMessage || 'Sign-in failed'}</Text>
        </Box>
      )}
      {state.showFallbackUrl && state.loginUrl && (
        <Box marginTop={1} flexDirection="column">
          <Text color="#8B95A5">Browser didn't open. Open this URL manually:</Text>
          <Text color="cyan">{state.loginUrl}</Text>
        </Box>
      )}
    </Box>
  );
}

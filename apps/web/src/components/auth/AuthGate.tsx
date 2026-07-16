import type { ReactNode } from 'react';
import { useAuth } from '../../hooks/useAuth.js';
import { LoginScreen } from './LoginScreen.js';

interface AuthGateProps {
  children: ReactNode;
}

/**
 * Wraps the whole app. Nothing renders until the session is resolved: an
 * existing cookie drops straight through to the dashboard, otherwise the login
 * screen is shown and stays until the shared token is accepted.
 */
export function AuthGate({ children }: AuthGateProps) {
  const { status, login } = useAuth();

  if (status === 'resolving') {
    return <div style={{ minHeight: '100vh', background: '#161826' }} />;
  }

  if (status === 'unauthed') {
    return <LoginScreen onSubmit={login} />;
  }

  return <>{children}</>;
}

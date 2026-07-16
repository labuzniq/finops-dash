import { useCallback, useEffect, useState } from 'react';
import { fetchAuthStatus, login as loginRequest, logout as logoutRequest } from '../api/client.js';

export type AuthStatus = 'resolving' | 'authed' | 'unauthed';

export interface UseAuth {
  status: AuthStatus;
  /** Submit the shared token; throws with a message on failure. */
  login: (token: string) => Promise<void>;
  logout: () => Promise<void>;
}

/**
 * The dashboard's whole gate. On mount it asks the API whether this browser
 * already holds a valid session cookie; if so we skip straight to the app.
 */
export function useAuth(): UseAuth {
  const [status, setStatus] = useState<AuthStatus>('resolving');

  useEffect(() => {
    let active = true;
    void fetchAuthStatus().then((ok) => {
      if (active) setStatus(ok ? 'authed' : 'unauthed');
    });
    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (token: string) => {
    await loginRequest(token);
    setStatus('authed');
  }, []);

  const logout = useCallback(async () => {
    await logoutRequest();
    setStatus('unauthed');
  }, []);

  return { status, login, logout };
}

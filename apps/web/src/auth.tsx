import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';

export type UserRole = 'ADMINISTRATOR' | 'SUPERVISOR' | 'MAINTENANCE_ENGINEER';
export type User = { id: string; email: string; name: string; role: UserRole; active: boolean };

type AuthContextValue = {
  user: User | null;
  loading: boolean;
  login(email: string, password: string): Promise<void>;
  logout(): void;
};

const AuthContext = createContext<AuthContextValue | null>(null);
const TOKEN_KEY = 'aeropulse-token';
export const getToken = () => sessionStorage.getItem(TOKEN_KEY);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(!!getToken());
  const queryClient = useQueryClient();

  const logout = () => {
    sessionStorage.removeItem(TOKEN_KEY);
    setUser(null);
    queryClient.clear();
  };

  useEffect(() => {
    const token = getToken();
    if (!token) return;
    const controller = new AbortController();
    void fetch('/api/v1/auth/me', { headers: { authorization: `Bearer ${token}` }, signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error('Session expired');
        return response.json() as Promise<{ user: User }>;
      })
      .then(result => setUser(result.user))
      .catch(error => { if (error.name !== 'AbortError') logout(); })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    window.addEventListener('aeropulse:unauthorized', logout);
    return () => window.removeEventListener('aeropulse:unauthorized', logout);
  });

  const login = async (email: string, password: string) => {
    const response = await fetch('/api/v1/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result?.error?.message ?? 'Login failed');
    sessionStorage.setItem(TOKEN_KEY, result.token);
    setUser(result.user as User);
  };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error('AuthProvider is missing');
  return auth;
}

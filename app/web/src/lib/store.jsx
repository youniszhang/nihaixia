import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api } from './api.js';

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.me()
      .then(({ user }) => setUser(user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  const login = useCallback(async (u, p) => {
    const { user } = await api.login(u, p);
    setUser(user);
  }, []);
  const register = useCallback(async (u, p, inviteCode = '') => {
    const { user } = await api.register(u, p, inviteCode);
    setUser(user);
  }, []);
  const logout = useCallback(async () => {
    await api.logout().catch(() => {});
    setUser(null);
  }, []);

  return (
    <AuthCtx.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthCtx.Provider>
  );
}

export function useAuth() {
  // Guard against null context (e.g. component rendered outside provider):
  // destructuring { user } from null crashes the whole tree — white screen.
  return useContext(AuthCtx) || {
    user: null,
    loading: false,
    login: async () => {},
    register: async () => {},
    logout: async () => {},
  };
}

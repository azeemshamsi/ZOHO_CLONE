import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, organization: null });

  const refresh = useCallback(async () => {
    if (!localStorage.getItem("mgi_token")) {
      setState({ loading: false, user: null, organization: null });
      return;
    }
    try {
      const { data } = await api.get("/auth/me");
      setState({ loading: false, user: data.user, organization: data.organization });
    } catch {
      localStorage.removeItem("mgi_token");
      setState({ loading: false, user: null, organization: null });
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signIn = (session) => {
    localStorage.setItem("mgi_token", session.token);
    setState({ loading: false, user: session.user, organization: session.organization });
  };

  const signOut = () => {
    localStorage.removeItem("mgi_token");
    setState({ loading: false, user: null, organization: null });
  };

  const setOrganization = (organization) => setState((s) => ({ ...s, organization }));

  return (
    <AuthContext.Provider value={{ ...state, signIn, signOut, refresh, setOrganization }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

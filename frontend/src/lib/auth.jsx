import { createContext, useContext, useEffect, useState, useCallback } from "react";
import api from "./api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [state, setState] = useState({ loading: true, user: null, organization: null, organizations: [] });

  const refresh = useCallback(async () => {
    if (!localStorage.getItem("mgi_token")) {
      setState({ loading: false, user: null, organization: null });
      return;
    }
    try {
      const { data } = await api.get("/auth/me");
      if (data.organization?._id) localStorage.setItem("ordexago_org", data.organization._id);
      setState({ loading: false, user: data.user, organization: data.organization, organizations: data.organizations || [] });
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
    if (session.organization?._id) localStorage.setItem("ordexago_org", session.organization._id);
    setState({ loading: false, user: session.user, organization: session.organization, organizations: session.organizations || [] });
  };

  const signOut = () => {
    localStorage.removeItem("mgi_token");
    localStorage.removeItem("ordexago_org");
    setState({ loading: false, user: null, organization: null });
  };

  const setOrganization = (organization) => setState((s) => ({ ...s, organization }));
  // Open another company: everything reloads for that company.
  const switchCompany = async (id) => {
    localStorage.setItem("ordexago_org", id);
    await api.post(`/companies/${id}/default`).catch(() => {});
    window.location.href = "/";
  };

  return (
    <AuthContext.Provider value={{ ...state, signIn, signOut, refresh, setOrganization, switchCompany }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);

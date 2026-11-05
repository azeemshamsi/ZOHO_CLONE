import axios from "axios";

// Same-origin API: works locally (Vite proxy) and on Render (Express serves both).
const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("mgi_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const org = localStorage.getItem("ordexago_org"); // company picked in the switcher
  if (org) config.headers["X-Org"] = org;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    // Subscription expired / suspended: back to the login page with the reason.
    if (err.response?.status === 402 && !err.config.url.startsWith("/auth/login")) {
      try {
        sessionStorage.setItem("ordexago_blocked", err.response.data?.message || "Your OrdexaGo subscription has expired.");
      } catch {}
      localStorage.removeItem("mgi_token");
      if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
    }
    if (err.response?.status === 401 && !err.config.url.startsWith("/auth/")) {
      localStorage.removeItem("mgi_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export const errMsg = (e) => e?.response?.data?.message || e?.message || "Something went wrong";

export default api;

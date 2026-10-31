import axios from "axios";

// Same-origin API: works locally (Vite proxy) and on Render (Express serves both).
const api = axios.create({ baseURL: "/api" });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("mgi_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

api.interceptors.response.use(
  (r) => r,
  (err) => {
    if (err.response?.status === 401 && !err.config.url.startsWith("/auth/")) {
      localStorage.removeItem("mgi_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export const errMsg = (e) => e?.response?.data?.message || e?.message || "Something went wrong";

export default api;

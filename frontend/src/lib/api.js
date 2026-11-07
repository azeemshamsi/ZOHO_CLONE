import axios from "axios";

// Same-origin API: works locally (Vite proxy) and on Render (Express serves both).
const api = axios.create({ baseURL: "/api" });

// This browser's device id (random, kept in localStorage). Admins approve devices for Amazon order data.
export function deviceId() {
  try {
    let id = localStorage.getItem("ordexago_device");
    if (!id || !/^[A-Za-z0-9-]{8,64}$/.test(id)) {
      id = window.crypto?.randomUUID ? window.crypto.randomUUID() : "d-" + Array.from(window.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem("ordexago_device", id);
    }
    return id;
  } catch {
    return "";
  }
}

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("mgi_token");
  if (token) config.headers.Authorization = `Bearer ${token}`;
  const org = localStorage.getItem("ordexago_org"); // company picked in the switcher
  if (org) config.headers["X-Org"] = org;
  const dev = deviceId();
  if (dev) config.headers["X-Device-Id"] = dev;
  return config;
});

api.interceptors.response.use(
  (r) => {
    // Sliding session: the server sends a fresh token while you're active.
    const fresh = r.headers?.["x-session-token"];
    if (fresh && localStorage.getItem("mgi_token")) localStorage.setItem("mgi_token", fresh);
    return r;
  },
  async (err) => {
    // Amazon order data from an unapproved device: offer "Request approval" (components/DeviceGate.jsx).
    if (err.response?.status === 403) {
      let d = err.response.data;
      if (typeof Blob !== "undefined" && d instanceof Blob) {
        try {
          d = JSON.parse(await d.text());
          err.response.data = d;
        } catch {}
      }
      if (d?.details?.code === "device_not_approved") window.dispatchEvent(new CustomEvent("ordexago:device-blocked", { detail: d }));
    }
    // Subscription expired / suspended: back to the login page with the reason.
    if (err.response?.status === 402 && !err.config.url.startsWith("/auth/login")) {
      try {
        sessionStorage.setItem("ordexago_blocked", err.response.data?.message || "Your OrdexaGo subscription has expired.");
      } catch {}
      localStorage.removeItem("mgi_token");
      if (!window.location.pathname.startsWith("/login")) window.location.href = "/login";
    }
    if (err.response?.status === 401 && !err.config.url.startsWith("/auth/")) {
      try {
        if (err.response.data?.message) sessionStorage.setItem("ordexago_blocked", err.response.data.message);
      } catch {}
      localStorage.removeItem("mgi_token");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export const errMsg = (e) => e?.response?.data?.message || e?.message || "Something went wrong";

export default api;

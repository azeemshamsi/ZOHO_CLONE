import { useEffect, useState } from "react";
import api from "./api";

// Branches and warehouses, fetched once and shared across forms.
let cache = null;
let pending = null;
export function loadLocations(force = false) {
  if (force) cache = null;
  if (cache) return Promise.resolve(cache);
  pending =
    pending ||
    Promise.all([api.get("/branches").catch(() => ({ data: [] })), api.get("/warehouses").catch(() => ({ data: [] }))]).then(([b, w]) => {
      cache = { branches: b.data, warehouses: w.data };
      pending = null;
      return cache;
    });
  return pending;
}
export function useLocations() {
  const [l, setL] = useState(cache || { branches: [], warehouses: [] });
  useEffect(() => {
    loadLocations().then(setL);
  }, []);
  return l;
}

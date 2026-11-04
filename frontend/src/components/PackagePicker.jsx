import SearchSelect from "./SearchSelect";

// Searchable package type picker (name, weight, size, and the SKUs already using it).
export const packageOptions = (list) =>
  list.map((p) => ({ value: p._id, label: p.name, sub: `${p.weight} kg · ${p.length}×${p.breadth}×${p.height} cm`, search: (p.products || []).map((x) => x.sku).join(" ") }));

export default function PackagePicker({ value, packages, onChange, placeholder = "None — type to search package types" }) {
  return <SearchSelect value={value || ""} options={packageOptions(packages)} onChange={onChange} placeholder={placeholder} emptyText="No package type matches" />;
}

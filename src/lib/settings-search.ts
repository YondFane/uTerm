import catalog from "../../shared/contracts/settings-sections-v1.json" with { type: "json" };

export const settingsSections = catalog.sections;

export function matchesSettingsSection(
  section: { id: string; label: string; keywords: string },
  query: string,
  english: string,
): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase();
  const terms = normalize(query).split(/\s+/u).filter(Boolean);
  const text = normalize([section.id, section.label, section.keywords, english].join(" "));
  return terms.every((term) => text.includes(term));
}

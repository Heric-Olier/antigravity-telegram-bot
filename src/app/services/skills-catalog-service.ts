export interface SkillCatalogItem {
  name: string;
  description?: string | undefined;
}

/**
 * agy has no command/skill listing API in v1; the catalog is always empty.
 */
export async function loadSkillsCatalog(_projectDirectory: string): Promise<SkillCatalogItem[]> {
  return [];
}

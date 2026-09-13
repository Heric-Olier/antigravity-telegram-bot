export interface CommandCatalogItem {
  name: string;
  description?: string | undefined;
}

/**
 * agy has no command catalog API in v1. Return an empty list so the command
 * catalog menu renders its empty state.
 */
export async function loadCommandCatalog(_projectDirectory: string): Promise<CommandCatalogItem[]> {
  return [];
}

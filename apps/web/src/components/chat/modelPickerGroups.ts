/**
 * OpenCode catalogs offer one model through several sources (`opencode-go/...`,
 * `opencode/...`, direct API keys like `deepseek/...`) that bill differently, so
 * OpenCode model lists group rows by the source in the id before the first slash.
 */
export type ModelPickerSourceRow<TModel> =
  | {
      readonly kind: "group";
      readonly source: string | null;
      readonly label: string;
      /** Official OpenCode sources render the OpenCode logo; others fall back to initials. */
      readonly hasLogo: boolean;
    }
  | { readonly kind: "model"; readonly model: TModel };

const OPENCODE_SOURCE_LABELS = new Map<string, string>([
  ["opencode-go", "OpenCode Go"],
  ["opencode", "OpenCode Zen"],
]);

const OPENCODE_SOURCE_ORDER = [...OPENCODE_SOURCE_LABELS.keys()];

/** The OpenCode catalog source a model runs on, e.g. `opencode-go` in `opencode-go/glm-5.3`. */
export function openCodeModelSource(modelId: string): string | null {
  const separatorIndex = modelId.indexOf("/");
  return separatorIndex > 0 ? modelId.slice(0, separatorIndex) : null;
}

function openCodeSourceLabel(source: string | null, subProviders: ReadonlyArray<string>): string {
  const official = source === null ? undefined : OPENCODE_SOURCE_LABELS.get(source);
  if (official) return official;
  return subProviders[0] || capitalize(source ?? "OpenCode");
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Groups OpenCode models into source sections with a header row before each section. Identical
 * ids inside one section collapse to a single row; the same model under different sources stays.
 */
export function planOpenCodeSourceRows<TModel extends { slug: string; subProvider?: string }>(
  models: ReadonlyArray<TModel>,
): ReadonlyArray<ModelPickerSourceRow<TModel>> {
  const rows: Array<ModelPickerSourceRow<TModel>> = [];
  const groups = new Map<
    string,
    { source: string | null; subProviders: string[]; models: TModel[] }
  >();
  const seen = new Set<string>();
  for (const model of models) {
    const source = openCodeModelSource(model.slug);
    const groupKey = source ?? "";
    let group = groups.get(groupKey);
    if (!group) {
      group = { source, subProviders: [], models: [] };
      groups.set(groupKey, group);
    }
    if (!seen.has(groupKey + "\n" + model.slug)) {
      seen.add(groupKey + "\n" + model.slug);
      group.models.push(model);
    }
    if (model.subProvider && !group.subProviders.includes(model.subProvider)) {
      group.subProviders.push(model.subProvider);
    }
  }

  const keys = [...groups.keys()].toSorted((left, right) => {
    const leftRank = orderRank(groups.get(left)!.source);
    const rightRank = orderRank(groups.get(right)!.source);
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank === Number.POSITIVE_INFINITY) {
      const delta = openCodeSourceLabel(
        groups.get(left)!.source,
        groups.get(left)!.subProviders,
      ).localeCompare(
        openCodeSourceLabel(groups.get(right)!.source, groups.get(right)!.subProviders),
      );
      if (delta !== 0) return delta;
    }
    return 0;
  });

  for (const key of keys) {
    const group = groups.get(key)!;
    rows.push({
      kind: "group",
      source: group.source,
      label: openCodeSourceLabel(group.source, group.subProviders),
      hasLogo: group.source === null || OPENCODE_SOURCE_LABELS.has(group.source),
    });
    for (const model of group.models) {
      rows.push({ kind: "model", model });
    }
  }
  return rows;
}

function orderRank(source: string | null): number {
  if (source === null) return Number.POSITIVE_INFINITY - 1;
  const index = OPENCODE_SOURCE_ORDER.indexOf(source);
  return index === -1 ? Number.POSITIVE_INFINITY : index;
}

/** The group a raw source renders as for screen readers and search, without the logo plumbing. */
export function openCodeSourceModelFields(model: {
  slug: string;
  subProvider?: string | undefined;
}): { readonly modelId: string; readonly groupName: string } {
  const source = openCodeModelSource(model.slug);
  return {
    modelId: model.slug,
    groupName: openCodeSourceLabel(source, model.subProvider ? [model.subProvider] : []),
  };
}

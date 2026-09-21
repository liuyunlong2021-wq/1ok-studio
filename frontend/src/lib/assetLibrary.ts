import { api } from "@/lib/api";
import { characterImageUrl, scenePropImageUrl } from "@/lib/characterImage";
import { getAssetUrl } from "@/lib/utils";
import type { Character, Prop, Project, Scene, Series } from "@/store/projectStore";

export type AssetKind = "characters" | "scenes" | "props";

const KINDS: AssetKind[] = ["characters", "scenes", "props"];

/** 资产库里的一「源」：一个系列池 / 一个独立项目 / 全局共享池。 */
export interface AssetSource {
  id: string; // `series-X` / `project-X` / `global`（列表 key）
  rawId: string; // 裸 series/project id（调 API 用）
  name: string;
  kind: "series" | "project" | "global";
  characters: Character[];
  scenes: Scene[];
  props: Prop[];
}

type AssetGroup = { characters?: Character[]; scenes?: Scene[]; props?: Prop[] };

/**
 * 资产库的全部来源：系列池 + 独立项目 + 全局共享池。
 *
 * 资产库页（AssetLibraryPage）和创作台的「从资产库选取」弹窗共用这一份 ——
 * 两边各写一套「哪些算资产库」迟早会漂，用户就会在两个地方看到两批资产。
 *
 * 系列里的集不单列：它们的资产就活在系列池里，单列会一图两卡。
 * `globalLabel` 是全局池的显示名（i18n 文案由调用方给）。
 */
export async function loadAssetSources(globalLabel: string): Promise<AssetSource[]> {
  const [seriesList, projects, globalPool] = await Promise.all([
    api.listSeries(),
    api.getProjects(),
    api.listLibraryAssets(),
  ]);

  const sources: AssetSource[] = [];
  const add = (id: string, rawId: string, name: string, kind: AssetSource["kind"], group: AssetGroup) => {
    const characters = group.characters ?? [];
    const scenes = group.scenes ?? [];
    const props = group.props ?? [];
    if (!characters.length && !scenes.length && !props.length) return;
    sources.push({ id, rawId, name, kind, characters, scenes, props });
  };

  for (const s of seriesList as Series[]) add(`series-${s.id}`, s.id, s.title, "series", s);
  for (const p of (projects as Project[]).filter((p) => !p.series_id)) {
    add(`project-${p.id}`, p.id, p.title, "project", p);
  }
  add("global", "global", globalLabel, "global", (globalPool ?? {}) as AssetGroup);

  return sources;
}

/** 选择器里的一条：一个**有图**的资产。 */
export interface AssetPickerItem {
  id: string;
  /** 交给后端的媒体引用（相对 output/），与 `input_media` 同一套写法。 */
  ref: string;
  /** 缩略图地址，可直接塞进 `<img src>` / `<video src>`。 */
  url: string;
  type: "image" | "video";
  label: string;
  /** 悬停提示用：这个资产属于哪个系列 / 项目。 */
  sourceName: string;
}

/**
 * 资产源 → 选择器条目。只收**有图**的资产（没图的选进去也当不了参考图），
 * 顺序＝源的顺序，源内按 角色 → 场景 → 道具。
 */
export function assetPickerItems(sources: AssetSource[]): AssetPickerItem[] {
  const items: AssetPickerItem[] = [];
  const seen = new Set<string>();

  for (const source of sources) {
    for (const kind of KINDS) {
      for (const asset of source[kind]) {
        // 取图只走 lib/characterImage（各 UI 只准有一套取图逻辑）。
        const ref =
          kind === "characters"
            ? characterImageUrl(asset as Character)
            : scenePropImageUrl(asset as Scene | Prop);
        if (!ref) continue;

        const id = `${kind}:${asset.id}`;
        if (seen.has(id)) continue;
        seen.add(id);

        items.push({
          id,
          ref,
          url: getAssetUrl(ref),
          type: /\.(mp4|mov|webm|avi|mkv)$/i.test(ref) ? "video" : "image",
          label: asset.name,
          sourceName: source.name,
        });
      }
    }
  }

  return items;
}

import { invoke } from "./invoke";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ViewType } from "./types";

/** 画面ごとの、マニュアルの章（manual.html の section の id。#235） */
const SECTIONS: Record<ViewType, string> = {
  menu: "screen",
  work: "work",
  insights: "analytics",
  dashboard: "tasks",
  kanban: "board",
  milestones: "milestones",
  routines: "routines",
  timeline: "journal",
  gantt: "gantt",
  branches: "branches",
  overview: "overview",
  pulls: "pulls",
  actions: "actions",
  releases: "releases",
  activity: "activity",
  settings: "settings",
};

export function manualSection(view: ViewType): string {
  return SECTIONS[view];
}

/** マニュアルをブラウザで開く。section があれば、その章から。開けなければ GitHub の README */
export async function openManual(section?: string) {
  try {
    await invoke("open_manual", { section: section ?? null });
  } catch {
    await openUrl("https://github.com/y0zrin/LifeManager/blob/main/README.md");
  }
}

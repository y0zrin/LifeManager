import { invoke } from "@tauri-apps/api/core";

/** リポジトリを選ぶ画面のカード。読めなかったところは null（人数は、書き込めない人には読めないことがある） */
export interface RepoCard {
  private: boolean;
  description: string | null;
  pushed_at: string | null;
  default_branch: string | null;
  /** "User" か "Organization" */
  owner_type: string | null;
  /** 開いている Issue（プルリクは入れない） */
  open_issues: number | null;
  /** 開いているプルリク（下書きは入れない） */
  open_pulls: number | null;
  /** そのうち、レビューをお願いされているもの */
  review_waiting: number | null;
  members: number | null;
  /** 右上に並べる顔（5 人まで） */
  faces: { login: string; avatar_url: string }[] | null;
}

export const repoCard = (owner: string, repo: string) => invoke<RepoCard>("repo_card", { owner, repo });

import { invoke } from "@tauri-apps/api/core";

// --- GitHub でログイン（デバイスフロー） ---

export interface DeviceCode {
  device_code: string;
  /** ブラウザで入れるコード（WDJB-MJHT など） */
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

export type Poll =
  | { status: "pending" }
  | { status: "slow_down"; interval: number }
  | { status: "done" }
  | { status: "expired" }
  | { status: "denied" }
  | { status: "failed"; message: string };

/** 「GitHub でログイン」に使う OAuth アプリの Client ID。空ならログインは使えない（トークンで入る） */
export const authClientId = () => invoke<string>("auth_client_id");
export const authStart = () => invoke<DeviceCode>("auth_start");
export const authPoll = (deviceCode: string) => invoke<Poll>("auth_poll", { deviceCode });
export const signOut = () => invoke<string>("sign_out");

// --- トークンの確認 ---

export interface RepoRef {
  owner: string;
  repo: string;
}

export interface RepoCheck extends RepoRef {
  ok: boolean;
  can_push: boolean;
  private: boolean;
  problem: "not_found" | "no_issues" | "org_restricted" | "sso" | "error" | null;
  message: string | null;
}

export interface TokenReport {
  login: string;
  name: string | null;
  avatar_url: string;
  kind: "oauth" | "fine-grained" | "classic" | "app" | "unknown";
  /** "2026-12-27 00:00:00 +0900" の形。期限のないトークンは null */
  expires_at: string | null;
  scopes: string[] | null;
  repos: RepoCheck[];
}

/** token を渡せばそれを、渡さなければ owner/repo のプロジェクトで使うトークン（なければいつもの）を確かめる */
export const checkToken = (args: { token?: string; owner?: string; repo?: string; repos: RepoRef[] }) =>
  invoke<TokenReport>("check_token", { token: args.token ?? null, owner: args.owner ?? null, repo: args.repo ?? null, repos: args.repos });

export interface TokenOverview {
  has_default: boolean;
  default_kind: TokenReport["kind"] | null;
  projects: (RepoRef & { source: "project" | "default" | "none" })[];
}

export const tokenOverview = () => invoke<TokenOverview>("token_overview");
export const setDefaultToken = (token: string) => invoke<string>("set_token", { token });
export const setProjectToken = (owner: string, repo: string, token: string) => invoke<string>("set_project_token", { owner, repo, token });
export const clearProjectToken = (owner: string, repo: string) => invoke<string>("clear_project_token", { owner, repo });

export interface UserRepo {
  full_name: string;
  name: string;
  owner: { login: string; type: string; avatar_url: string };
  private: boolean;
  updated_at: string;
  permissions?: { push: boolean };
}

/** ログインした人が使えるリポジトリ（更新の新しい順） */
export const listUserRepos = async () => JSON.parse(await invoke<string>("list_user_repos")) as UserRepo[];

// --- 表示 ---

export const KIND_LABELS: Record<TokenReport["kind"], string> = {
  oauth: "GitHub でログイン",
  "fine-grained": "Fine-grained トークン",
  classic: "Classic トークン",
  app: "GitHub App",
  unknown: "トークン",
};

/** 期限まで何日か（期限のないトークンは null） */
export function expiryOf(report: Pick<TokenReport, "expires_at">): { date: string; days: number } | null {
  if (!report.expires_at) return null;
  // "2026-12-27 00:00:00 +0900" → Date
  const m = report.expires_at.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2}) ?([+-]\d{2})(\d{2})/);
  const at = m ? new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${m[7]}:${m[8]}`) : new Date(report.expires_at);
  if (Number.isNaN(at.getTime())) return null;
  const days = Math.floor((at.getTime() - Date.now()) / 86400000);
  return { date: `${at.getFullYear()}/${at.getMonth() + 1}/${at.getDate()}`, days };
}

/** 期限が近い（この日数以内）と、画面の上で知らせる */
export const EXPIRY_WARN_DAYS = 7;

/**
 * GitHub で Fine-grained トークンを作るページ（名前・期限・権限を入れた状態で開く）。
 * 使うリポジトリ（Repository access）だけは、GitHub の決まりで先に入れられないので、利用者が選ぶ
 */
export function tokenCreateUrl(owner?: string): string {
  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
  const params = new URLSearchParams({
    name: `Life Manager ${stamp}`,
    description: "Life Manager で Issue とファイル（設定・日誌）を読み書きする",
    expires_in: "90",
    issues: "write",
    contents: "write",
    metadata: "read",
  });
  if (owner) params.set("target_name", owner);
  return `https://github.com/settings/personal-access-tokens/new?${params.toString()}`;
}

/** 組織（Organization）に、Life Manager の利用の許可をお願いするページ（アプリの許可の画面） */
export const orgApprovalUrl = (clientId: string) => `https://github.com/settings/connections/applications/${clientId}`;

/** トークンの一覧の画面（Repository access を足すとき） */
export const TOKENS_PAGE = "https://github.com/settings/personal-access-tokens";

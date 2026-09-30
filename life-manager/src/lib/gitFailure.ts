// 最後に失敗した git（「助けを求める」に添える）。画面に出した git の失敗は、みな splitGitError を通るので、そこで覚える

export interface GitFailure {
  command: string;
  message: string;
  at: number;
}

let last: GitFailure | null = null;

export function rememberGitFailure(command: string, message: string) {
  last = { command, message, at: Date.now() };
}

/** 最後に失敗した git（古すぎるものは出さない。はじめは 30 分） */
export function lastGitFailure(maxAgeMs = 30 * 60 * 1000): GitFailure | null {
  return last && Date.now() - last.at <= maxAgeMs ? last : null;
}

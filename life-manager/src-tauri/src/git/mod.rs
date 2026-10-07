//! PC に入っている git コマンドを呼び出して、ローカルのリポジトリを操作・閲覧する。
//! スマホ版では git を持たないため使わない（呼ばれても「git が見つかりません」になる）。
//! 履歴の形（history）は、GitHub API から作る履歴（github::history）とも共通。

mod account;
pub mod commands;
mod conflict;
pub mod history;
mod ignore;
pub mod media;
pub mod publish;
pub(crate) mod runner;
mod setup;
mod status;
mod watch;

#[cfg(test)]
pub(crate) mod scenario_tests;

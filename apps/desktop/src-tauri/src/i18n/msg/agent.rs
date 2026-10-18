//! Agents, tasks, worktrees, PRs, reviews, GitHub issues, automations (agent/*).

crate::i18n::messages! {
  pub enum AgentMsg {
    /// The webview shows its gh setup help when an error contains rustErrors.ts `ghMissing`
    /// (checked by i18n's tests).
    GhMissing {
      en: "GitHub CLI (gh) not found: install it with `brew install gh`, then run `gh auth login`",
      th: "ไม่พบ GitHub CLI (gh): ติดตั้งด้วย `brew install gh` แล้ว `gh auth login`",
    },
  }
}

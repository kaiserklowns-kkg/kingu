# Kingu shell integration (zsh). Kingu starts zsh with ZDOTDIR set to this folder: each startup
# file here runs the user's own one from their ZDOTDIR, and .zshrc adds kingu.zsh. Kingu rewrites
# these files, so edits are lost.
KINGU_ZDOTDIR=$ZDOTDIR
ZDOTDIR=${KINGU_USER_ZDOTDIR:-$HOME}
if [[ -f $ZDOTDIR/.zshenv ]]; then
	. $ZDOTDIR/.zshenv
fi
# The user's .zshenv may move ZDOTDIR (e.g. to ~/.config/zsh): the other files are read from there.
KINGU_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$KINGU_ZDOTDIR

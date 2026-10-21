# Kingu shell integration (zsh): the user's .zshrc, then the integration itself.
ZDOTDIR=$KINGU_USER_ZDOTDIR
# /etc/zshrc named the history file after this folder: use the user's one.
if [[ $HISTFILE == $KINGU_ZDOTDIR/.zsh_history ]]; then
	HISTFILE=$ZDOTDIR/.zsh_history
fi
if [[ -f $ZDOTDIR/.zshrc ]]; then
	. $ZDOTDIR/.zshrc
fi
KINGU_USER_ZDOTDIR=$ZDOTDIR
if [[ -o interactive ]]; then
	. $KINGU_ZDOTDIR/kingu.zsh
fi
# A login shell still reads .zlogin from here; any other shell is done starting.
if [[ -o login ]]; then
	ZDOTDIR=$KINGU_ZDOTDIR
else
	unset KINGU_ZDOTDIR KINGU_USER_ZDOTDIR
fi

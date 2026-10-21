# Kingu shell integration (zsh): the user's .zlogin, then ZDOTDIR is the user's again.
ZDOTDIR=$KINGU_USER_ZDOTDIR
if [[ -f $ZDOTDIR/.zlogin ]]; then
	. $ZDOTDIR/.zlogin
fi
unset KINGU_ZDOTDIR KINGU_USER_ZDOTDIR

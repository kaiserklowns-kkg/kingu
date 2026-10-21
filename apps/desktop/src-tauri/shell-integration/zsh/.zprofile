# Kingu shell integration (zsh): the user's .zprofile (login shells).
ZDOTDIR=$KINGU_USER_ZDOTDIR
if [[ -f $ZDOTDIR/.zprofile ]]; then
	. $ZDOTDIR/.zprofile
fi
KINGU_USER_ZDOTDIR=$ZDOTDIR
ZDOTDIR=$KINGU_ZDOTDIR

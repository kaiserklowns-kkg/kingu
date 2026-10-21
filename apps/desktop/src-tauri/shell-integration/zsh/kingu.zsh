# Kingu shell integration for zsh: marks each prompt, command and result with VS Code's OSC 633
# sequences so the terminal knows where commands start and end, their exit codes and the
# directory (A prompt start, B prompt end, E command line, C output start, D;code finished,
# P;Cwd=dir). Also works sourced by hand at the end of ~/.zshrc.
[[ -o interactive ]] || return 0
(( ${+__kingu_si} )) && return 0
typeset -g __kingu_si=1
typeset -g __kingu_running=0
typeset -g __kingu_prior_ps1=
builtin autoload -Uz add-zsh-hook

# REPLY: $1 with \ ; and control characters escaped (\\, \x3b, \xHH).
__kingu_esc() {
	builtin local s=${1//\\/\\\\} out= c
	s=${s//;/\\x3b}
	if [[ $s == *[[:cntrl:]]* ]]; then
		builtin local i
		for (( i = 1; i <= ${#s}; i++ )); do
			c=${s[i]}
			if [[ $c == [[:cntrl:]] ]]; then
				out+="\\x${(l:2::0:)$(( [##16] #c ))}"
			else
				out+=$c
			fi
		done
		s=$out
	fi
	REPLY=$s
}

__kingu_precmd() {
	builtin local code=$?
	if (( __kingu_running )); then
		builtin printf '\e]633;D;%s\a' $code
	else
		builtin printf '\e]633;D\a'
	fi
	__kingu_running=0
	__kingu_esc "$PWD"
	builtin printf '\e]633;P;Cwd=%s\a' "$REPLY"
	# A theme may rebuild PS1 in its own precmd (this hook runs last): mark the prompt shown now.
	if [[ $PS1 != *$'\e]633;A'* ]]; then
		__kingu_prior_ps1=$PS1
		PS1=$'%{\e]633;A\a%}'"$PS1"$'%{\e]633;B\a%}'
	fi
}

__kingu_preexec() {
	[[ -n $__kingu_prior_ps1 ]] && PS1=$__kingu_prior_ps1
	__kingu_prior_ps1=
	__kingu_running=1
	__kingu_esc "$1"
	builtin printf '\e]633;E;%s\a\e]633;C\a' "$REPLY"
}

add-zsh-hook precmd __kingu_precmd
add-zsh-hook preexec __kingu_preexec
# Kingu's own property: which shell this is (Run Recent Command keeps history per shell).
builtin printf '\e]633;P;Shell=zsh\a'

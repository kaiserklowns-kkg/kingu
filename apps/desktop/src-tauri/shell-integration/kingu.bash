# Kingu shell integration for bash. Kingu starts bash with `--init-file` this file, which reads
# the startup files bash would have read itself, then marks each prompt, command and result with
# VS Code's OSC 633 sequences (A prompt start, B prompt end, E command line, C output start,
# D;code finished, P;Cwd=dir). Also works sourced by hand at the end of ~/.bashrc.
if [[ -n ${KINGU_SHELL_LOGIN-} ]]; then
	builtin unset KINGU_SHELL_LOGIN KINGU_SHELL_INJECTED
	[[ -r /etc/profile ]] && . /etc/profile
	if [[ -r ~/.bash_profile ]]; then
		. ~/.bash_profile
	elif [[ -r ~/.bash_login ]]; then
		. ~/.bash_login
	elif [[ -r ~/.profile ]]; then
		. ~/.profile
	fi
elif [[ -n ${KINGU_SHELL_INJECTED-} ]]; then
	builtin unset KINGU_SHELL_INJECTED
	[[ -r ~/.bashrc ]] && . ~/.bashrc
fi

[[ $- == *i* ]] || return 0
[[ -n ${__kingu_si-} ]] && return 0
__kingu_si=1
__kingu_state=prompt
__kingu_last_hist=
__kingu_prior_ps1=

# REPLY: $1 with \ ; and control characters escaped (\\, \x3b, \xHH).
__kingu_esc() {
	local s=${1//\\/\\\\} out= c i
	s=${s//;/\\x3b}
	if [[ $s == *[[:cntrl:]]* ]]; then
		for (( i = 0; i < ${#s}; i++ )); do
			c=${s:i:1}
			if [[ $c == [[:cntrl:]] ]]; then
				builtin printf -v c '\\x%02x' "'$c"
			fi
			out+=$c
		done
		s=$out
	fi
	REPLY=$s
}

# First in PROMPT_COMMAND: the finished command's exit code, handed on to what runs after it.
__kingu_precmd() {
	local code=$?
	if [[ $__kingu_state == running ]]; then
		builtin printf '\e]633;D;%s\a' "$code"
	else
		builtin printf '\e]633;D\a'
	fi
	__kingu_state=prompt
	__kingu_esc "$PWD"
	builtin printf '\e]633;P;Cwd=%s\a' "$REPLY"
	return $code
}

# Last in PROMPT_COMMAND: mark the prompt (after anything that rebuilt PS1).
__kingu_prompt() {
	local code=$?
	if [[ $PS1 != *'\[\e]633;A\a\]'* ]]; then
		__kingu_prior_ps1=$PS1
		PS1='\[\e]633;A\a\]'"$PS1"'\[\e]633;B\a\]'
	fi
	__kingu_state=armed
	return $code
}

# Before the typed command runs (the DEBUG trap, or bash-preexec's preexec_functions).
__kingu_preexec() {
	[[ $__kingu_state == armed ]] || return 0
	__kingu_state=running
	[[ -n $__kingu_prior_ps1 ]] && PS1=$__kingu_prior_ps1
	__kingu_prior_ps1=
	local line
	line=$(HISTTIMEFORMAT= builtin history 1)
	# The last history entry is this command only when its number moved (ignorespace skips it).
	if [[ $line =~ ^[[:space:]]*([0-9]+)[\*[:space:]]+(.*)$ ]] && [[ ${BASH_REMATCH[1]} != "$__kingu_last_hist" ]]; then
		__kingu_last_hist=${BASH_REMATCH[1]}
		__kingu_esc "${BASH_REMATCH[2]}"
		builtin printf '\e]633;E;%s\a' "$REPLY"
	fi
	builtin printf '\e]633;C\a'
}

__kingu_debug_trap() {
	[[ -n ${COMP_LINE-} ]] && return 0
	case $BASH_COMMAND in
		__kingu_*) return 0 ;;
	esac
	__kingu_preexec
}

if [[ -n ${bash_preexec_imported-} || -n ${__bp_imported-} ]]; then
	precmd_functions=(__kingu_precmd "${precmd_functions[@]}" __kingu_prompt)
	preexec_functions+=(__kingu_preexec)
else
	__kingu_pc=${PROMPT_COMMAND-}
	while [[ $__kingu_pc == *[\;[:space:]] ]]; do __kingu_pc=${__kingu_pc%?}; done
	PROMPT_COMMAND="__kingu_precmd; ${__kingu_pc:+$__kingu_pc; }__kingu_prompt"
	builtin unset __kingu_pc
	if [[ -z $(builtin trap -p DEBUG) ]]; then
		builtin trap '__kingu_debug_trap' DEBUG
	elif (( BASH_VERSINFO[0] > 4 || (BASH_VERSINFO[0] == 4 && BASH_VERSINFO[1] >= 4) )); then
		# Someone else owns the DEBUG trap: PS0 still marks where the output starts.
		PS0='\e]633;C\a'"${PS0-}"
	fi
fi
# The history number now, so the first command's E is never the previous session's last line.
__kingu_line=$(HISTTIMEFORMAT= builtin history 1)
[[ $__kingu_line =~ ^[[:space:]]*([0-9]+) ]] && __kingu_last_hist=${BASH_REMATCH[1]}
builtin unset __kingu_line
# Kingu's own property: which shell this is (Run Recent Command keeps history per shell).
builtin printf '\e]633;P;Shell=bash\a'

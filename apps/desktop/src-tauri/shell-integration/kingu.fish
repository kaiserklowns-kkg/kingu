# Kingu shell integration for fish (Kingu runs it with `--init-command`, after config.fish): marks
# each prompt, command and result with VS Code's OSC 633 sequences (A prompt start, B prompt end,
# E command line, C output start, D;code finished, P;Cwd=dir). Also works sourced by hand from
# ~/.config/fish/config.fish.
status is-interactive; or exit
set -q __kingu_si; and exit
set -g __kingu_si 1

# The value with \ ; and control characters escaped (\\, \x3b, \xHH), as one line.
function __kingu_esc
	set -l s (string replace -a -- '\\' '\\\\' $argv[1] | string collect)
	set s (string replace -a -- \n '\\x0a' $s | string collect)
	set s (string replace -a -- \r '\\x0d' $s | string collect)
	set s (string replace -a -- \t '\\x09' $s | string collect)
	set s (string replace -a -- \e '\\x1b' $s | string collect)
	set s (string replace -a -- \a '\\x07' $s | string collect)
	string replace -a -- ';' '\\x3b' $s
end

function __kingu_status
	return $argv[1]
end

function __kingu_cwd --on-variable PWD
	printf '\e]633;P;Cwd=%s\a' (__kingu_esc $PWD)
end

function __kingu_preexec --on-event fish_preexec
	printf '\e]633;E;%s\a\e]633;C\a' (__kingu_esc "$argv")
end

function __kingu_postexec --on-event fish_postexec
	printf '\e]633;D;%s\a' $status
end

# The prompt between A and B, keeping $status for the user's prompt.
if functions -q fish_prompt
	functions -c fish_prompt __kingu_user_prompt
else
	function __kingu_user_prompt
		printf '%s> ' (prompt_pwd)
	end
end
function fish_prompt
	set -l code $status
	printf '\e]633;A\a'
	__kingu_status $code
	__kingu_user_prompt
	printf '\e]633;B\a'
end

__kingu_cwd
# Kingu's own property: which shell this is (Run Recent Command keeps history per shell).
printf '\e]633;P;Shell=fish\a'

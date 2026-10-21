# Kingu shell integration for PowerShell (Kingu runs it with `-NoExit -Command`, after the
# profile): marks each prompt, command and result with VS Code's OSC 633 sequences (A prompt
# start, B prompt end, E command line, C output start, D;code finished, P;Cwd=dir). Also works
# dot-sourced by hand from $PROFILE.
if ($Global:__KinguShellIntegration) { return }
$Global:__KinguShellIntegration = $true
$Global:__KinguRunning = $false

# The value with \ ; and control characters escaped (\\, \x3b, \xHH).
function Global:__Kingu-Escape([string]$Value) {
	$out = [System.Text.StringBuilder]::new()
	foreach ($c in $Value.ToCharArray()) {
		if ($c -eq '\') { [void]$out.Append('\\') }
		elseif ($c -eq ';' -or [int]$c -lt 0x20) { [void]$out.Append(('\x{0:x2}' -f [int]$c)) }
		else { [void]$out.Append($c) }
	}
	$out.ToString()
}

$Global:__KinguUserPrompt = $function:Prompt

function Global:Prompt() {
	$ok = $global:?
	$code = $global:LASTEXITCODE
	$e = [char]27
	$b = [char]7
	$s = ''
	if ($Global:__KinguRunning) {
		$exit = if ($ok) { 0 } elseif ($code -is [int] -and $code -ne 0) { $code } else { 1 }
		$s += "$e]633;D;$exit$b"
	} else {
		$s += "$e]633;D$b"
	}
	$Global:__KinguRunning = $false
	$s += "$e]633;P;Cwd=$(__Kingu-Escape $executionContext.SessionState.Path.CurrentLocation.ProviderPath)$b"
	$s += "$e]633;A$b"
	$s += (& $Global:__KinguUserPrompt) -join ''
	$s += "$e]633;B$b"
	$global:LASTEXITCODE = $code
	$s
}

# PSReadLine hands over the typed line: that is where the command starts running.
if (Test-Path Function:\PSConsoleHostReadLine) {
	$Global:__KinguReadLine = $function:PSConsoleHostReadLine
	function Global:PSConsoleHostReadLine {
		$line = (& $Global:__KinguReadLine) -join ''
		if (-not [string]::IsNullOrWhiteSpace($line)) {
			$Global:__KinguRunning = $true
			[Console]::Write("$([char]27)]633;E;$(__Kingu-Escape $line)$([char]7)$([char]27)]633;C$([char]7)")
		}
		$line
	}
}

# Kingu's own property: which shell this is (Run Recent Command keeps history per shell).
[Console]::Write("$([char]27)]633;P;Shell=pwsh$([char]7)")

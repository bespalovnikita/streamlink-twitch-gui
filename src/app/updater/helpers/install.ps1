param(
	[Parameter(Mandatory = $true)][string]$JobFile,
	[switch]$Prepare
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$script:failureCode = 'UPDATE_START'
$script:job = $null

function Fail([string]$Code, [string]$Message) {
	$script:failureCode = $Code
	throw $Message
}

function Canonical-Path([string]$Value) {
	if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
		Fail 'UPDATE_LOCATION' 'An absolute path is required'
	}
	return [IO.Path]::GetFullPath($Value).TrimEnd([char[]]@('\', '/'))
}

function Same-Path([string]$First, [string]$Second) {
	return [string]::Equals($First, $Second, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparse([string]$Path) {
	$current = $Path
	while (-not [string]::IsNullOrEmpty($current)) {
		if (Test-Path -LiteralPath $current) {
			$item = Get-Item -LiteralPath $current -Force
			if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
				Fail 'UPDATE_LOCATION' 'Reparse points are not supported'
			}
		}
		$next = [IO.Path]::GetDirectoryName($current)
		if ($next -eq $current) { break }
		$current = $next
	}
}

function Write-Text([string]$Path, [string]$Value) {
	$temp = "$Path.$PID.tmp"
	[IO.File]::WriteAllText($temp, $Value, (New-Object Text.UTF8Encoding($false)))
	if (Test-Path -LiteralPath $Path) {
		[IO.File]::Replace($temp, $Path, $null)
	} else {
		[IO.File]::Move($temp, $Path)
	}
}

function Write-Status([string]$State, [string]$Code) {
	if ($null -ne $script:job) {
		$value = @{ state = $State; code = $Code } | ConvertTo-Json -Compress
		Write-Text $script:job.statusFile $value
	}
}

function Read-Job {
	$fullJobFile = Canonical-Path $JobFile
	Assert-NoReparse $fullJobFile
	$data = [IO.File]::ReadAllText($fullJobFile) | ConvertFrom-Json
	if ($data.schema -ne 1 -or $data.platform -ne 'win32' -or $data.arch -ne 'x64') {
		Fail 'UPDATE_START' 'Unsupported update job'
	}
	if ($data.commit -cnotmatch '^[a-f0-9]{40}$' -or
		$data.token -cnotmatch '^[a-f0-9]{64}$' -or
		$data.archiveSha256 -cnotmatch '^[a-f0-9]{64}$') {
		Fail 'UPDATE_START' 'Invalid update identity'
	}
	if ($data.executable -cne 'streamlink-twitch-gui.exe' -or
		$data.args -isnot [Array] -or $data.args.Count -gt 100 -or
		$data.parentPid -lt 0 -or $data.parentPid -gt [int]::MaxValue -or
		$data.timeoutMs -lt 100 -or $data.timeoutMs -gt 600000 -or
		$data.archiveSize -le 0) {
		Fail 'UPDATE_START' 'Invalid update parameters'
	}
	foreach ($argument in $data.args) {
		if ($argument -isnot [string] -or $argument.Contains([string][char]0)) {
			Fail 'UPDATE_START' 'Invalid application argument'
		}
	}
	foreach ($key in @('installDir', 'jobDir', 'stageDir', 'backupDir', 'archivePath',
		'helperPath', 'jobFile', 'ackFile', 'readyFile', 'statusFile')) {
		$data.$key = Canonical-Path $data.$key
		Assert-NoReparse $data.$key
	}
	if (-not (Same-Path $fullJobFile $data.jobFile)) {
		Fail 'UPDATE_LOCATION' 'The job file does not match the job'
	}
	if (-not (Same-Path $data.archivePath (Join-Path $data.jobDir 'update.zip'))) {
		Fail 'UPDATE_LOCATION' 'The archive path does not match the job'
	}
	$parent = [IO.Path]::GetDirectoryName($data.installDir)
	if ([string]::IsNullOrEmpty($parent) -or
		-not (Test-Path -LiteralPath $data.installDir -PathType Container)) {
		Fail 'UPDATE_LOCATION' 'The installation directory is not supported'
	}
	$expectedJob = Join-Path $parent ('.stgui-' + $data.token.Substring(0, 16))
	if (-not (Same-Path $data.jobDir $expectedJob) -or
		-not (Same-Path $data.stageDir ($data.jobDir + '-stage')) -or
		-not (Same-Path $data.backupDir ($data.jobDir + '-backup'))) {
		Fail 'UPDATE_LOCATION' 'Update directories do not match the job token'
	}
	$directories = @($data.installDir, $data.jobDir, $data.stageDir, $data.backupDir)
	if (@($directories | Sort-Object -Unique).Count -ne 4) {
		Fail 'UPDATE_LOCATION' 'Update directories must be distinct'
	}
	foreach ($directory in @($data.jobDir, $data.stageDir, $data.backupDir)) {
		if (-not (Same-Path ([IO.Path]::GetDirectoryName($directory)) $parent)) {
			Fail 'UPDATE_LOCATION' 'Update directories must be siblings'
		}
	}
	foreach ($path in @($data.jobFile, $data.helperPath, $data.ackFile,
		$data.readyFile, $data.statusFile)) {
		if (-not (Same-Path ([IO.Path]::GetDirectoryName($path)) $data.jobDir)) {
			Fail 'UPDATE_LOCATION' 'Update control files must be in the job directory'
		}
	}
	$controls = @($data.jobFile, $data.helperPath, $data.ackFile,
		$data.readyFile, $data.statusFile)
	if (@($controls | Sort-Object -Unique).Count -ne 5 -or
		(Test-Path -LiteralPath $data.backupDir) -or
		(Test-Path -LiteralPath $data.ackFile)) {
		Fail 'UPDATE_LOCATION' 'Update paths already exist or overlap'
	}
	if (-not (Test-Path -LiteralPath $data.jobDir -PathType Container)) {
		Fail 'UPDATE_LOCATION' 'The update job directory is missing'
	}
	return $data
}

function Check-Archive {
	$script:failureCode = 'UPDATE_INTEGRITY'
	$file = Get-Item -LiteralPath $script:job.archivePath -Force
	if ($file.PSIsContainer -or $file.Length -ne $script:job.archiveSize) {
		Fail 'UPDATE_INTEGRITY' 'Archive size does not match the manifest'
	}
	$hash = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
	if ($hash -cne $script:job.archiveSha256) {
		Fail 'UPDATE_INTEGRITY' 'Archive checksum does not match the manifest'
	}
}

function Check-Package {
	$script:failureCode = 'UPDATE_PACKAGE'
	$directory = $script:job.stageDir
	$package = [IO.File]::ReadAllText((Join-Path $directory 'package.json')) | ConvertFrom-Json
	$identity = [IO.File]::ReadAllText((Join-Path $directory 'build-info.json')) | ConvertFrom-Json
	if ($package.name -cne 'streamlink-twitch-gui' -or
		$identity.commit -cne $script:job.commit) {
		Fail 'UPDATE_PACKAGE' 'The extracted application has an unexpected identity'
	}
	$binary = Join-Path $directory $script:job.executable
	$stream = [IO.File]::OpenRead($binary)
	$reader = New-Object IO.BinaryReader($stream)
	try {
		if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) {
			Fail 'UPDATE_PACKAGE' 'The application is not a Windows executable'
		}
		$stream.Position = 0x3C
		$offset = $reader.ReadUInt32()
		if ($offset -gt $stream.Length - 6) {
			Fail 'UPDATE_PACKAGE' 'The application has an invalid executable header'
		}
		$stream.Position = $offset
		if ($reader.ReadUInt32() -ne 0x00004550 -or $reader.ReadUInt16() -ne 0x8664) {
			Fail 'UPDATE_PACKAGE' 'The application is not a Windows x64 executable'
		}
	} finally {
		$reader.Dispose()
		$stream.Dispose()
	}
}

function Expand-Application {
	if (Test-Path -LiteralPath $script:job.stageDir) {
		Fail 'UPDATE_LOCATION' 'The staging directory already exists'
	}
	Check-Archive
	$script:failureCode = 'UPDATE_ARCHIVE'
	Add-Type -AssemblyName System.IO.Compression.FileSystem
	$archive = [IO.Compression.ZipFile]::OpenRead($script:job.archivePath)
	try {
		$seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
		$files = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
		$entries = @()
		[long]$total = 0
		if ($archive.Entries.Count -gt 100000) {
			Fail 'UPDATE_ARCHIVE' 'The archive contains too many entries'
		}
		foreach ($entry in $archive.Entries) {
			$name = $entry.FullName
			if (-not $name.StartsWith('streamlink-twitch-gui/', [StringComparison]::Ordinal) -or
				$name.Contains('\') -or $name -match '[\x00-\x1F<>:"|?*]') {
				Fail 'UPDATE_ARCHIVE' 'The archive contains an unsafe path'
			}
			$relative = $name.Substring('streamlink-twitch-gui/'.Length)
			$isDirectory = $name.EndsWith('/')
			if ($isDirectory -and $relative.Length -gt 0) {
				$relative = $relative.Substring(0, $relative.Length - 1)
			}
			$kind = (([long]$entry.ExternalAttributes -shr 16) -band 0xF000)
			if (($kind -ne 0 -and $kind -ne 0x4000 -and $kind -ne 0x8000) -or
				(($entry.ExternalAttributes -band 0x400) -ne 0) -or
				($kind -eq 0x4000 -and -not $isDirectory) -or
				($kind -eq 0x8000 -and $isDirectory)) {
				Fail 'UPDATE_ARCHIVE' 'Archive links and special files are not supported'
			}
			if ($relative.Length -eq 0) {
				if (-not $isDirectory -or $name -cne 'streamlink-twitch-gui/' -or
					-not $seen.Add('')) {
					Fail 'UPDATE_ARCHIVE' 'Invalid archive root'
				}
				continue
			}
			$parts = $relative.Split('/')
			foreach ($part in $parts) {
				if ($part.Length -eq 0 -or $part -eq '.' -or $part -eq '..' -or
					$part -match '[\. ]$' -or
					$part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
					Fail 'UPDATE_ARCHIVE' 'The archive contains an unsafe path component'
				}
			}
			if (-not $seen.Add($relative)) {
				Fail 'UPDATE_ARCHIVE' 'The archive contains colliding paths'
			}
			if (-not $isDirectory) { [void]$files.Add($relative) }
			$total += $entry.Length
			if ($total -gt 4294967296 -or ($isDirectory -and $entry.Length -ne 0)) {
				Fail 'UPDATE_ARCHIVE' 'The archive exceeds the extraction limit'
			}
			$entries += @{ entry = $entry; relative = $relative; directory = $isDirectory }
		}
		foreach ($item in $entries) {
			$ancestor = $item.relative
			while ($ancestor.Contains('/')) {
				$ancestor = $ancestor.Substring(0, $ancestor.LastIndexOf('/'))
				if ($files.Contains($ancestor)) {
					Fail 'UPDATE_ARCHIVE' 'An archive file is also used as a directory'
				}
			}
		}
		[void][IO.Directory]::CreateDirectory($script:job.stageDir)
		$buffer = New-Object byte[] 65536
		foreach ($item in $entries) {
			$destination = Join-Path $script:job.stageDir $item.relative.Replace('/', '\')
			if ($item.directory) {
				[void][IO.Directory]::CreateDirectory($destination)
			} else {
				[void][IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination))
				$input = $item.entry.Open()
				$output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew)
				try {
					[long]$copied = 0
					while (($count = $input.Read($buffer, 0, $buffer.Length)) -gt 0) {
						$copied += $count
						if ($copied -gt $item.entry.Length) {
							Fail 'UPDATE_ARCHIVE' 'An archive entry exceeds its declared size'
						}
						$output.Write($buffer, 0, $count)
					}
					if ($copied -ne $item.entry.Length) {
						Fail 'UPDATE_ARCHIVE' 'An archive entry is truncated'
					}
				} finally { $output.Dispose(); $input.Dispose() }
			}
		}
	} finally {
		$archive.Dispose()
	}
	Check-Package
}

function Quote-Argument([string]$Value) {
	# ProcessStartInfo.Arguments follows the Windows CRT command line rules.
	return '"' + ([regex]::Replace($Value, '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"'
}

function Launch-Application([bool]$Updating) {
	$start = New-Object Diagnostics.ProcessStartInfo
	$start.FileName = Join-Path $script:job.installDir $script:job.executable
	$start.WorkingDirectory = $script:job.installDir
	$start.UseShellExecute = $false
	$start.Arguments = (@($script:job.args | ForEach-Object { Quote-Argument $_ }) -join ' ')
	[void]$start.EnvironmentVariables.Remove('STGUI_UPDATE_JOB')
	[void]$start.EnvironmentVariables.Remove('STGUI_UPDATE_TOKEN')
	[void]$start.EnvironmentVariables.Remove('STGUI_UPDATE_ROLLBACK')
	if ($Updating) {
		$start.EnvironmentVariables['STGUI_UPDATE_JOB'] = $script:job.jobFile
		$start.EnvironmentVariables['STGUI_UPDATE_TOKEN'] = $script:job.token
	} else {
		$start.EnvironmentVariables['STGUI_UPDATE_ROLLBACK'] = $script:job.jobFile
	}
	return [Diagnostics.Process]::Start($start)
}

function Move-WithRetry([string]$Source, [string]$Destination) {
	$deadline = [DateTime]::UtcNow.AddSeconds(30)
	while ($true) {
		try {
			[IO.Directory]::Move($Source, $Destination)
			return
		} catch {
			if ([DateTime]::UtcNow -ge $deadline) { throw }
			Start-Sleep -Milliseconds 100
		}
	}
}

function Install-Application {
	Check-Archive
	Check-Package
	$script:failureCode = 'UPDATE_START'
	if (Test-Path -LiteralPath $script:job.readyFile) {
		Fail 'UPDATE_START' 'The update job has already started'
	}
	Write-Text $script:job.readyFile $script:job.token
	$deadline = [DateTime]::UtcNow.AddSeconds(120)
	while ($script:job.parentPid -gt 0 -and
		(Get-Process -Id $script:job.parentPid -ErrorAction SilentlyContinue)) {
		if ([DateTime]::UtcNow -ge $deadline) {
			Fail 'UPDATE_START' 'The previous application did not exit'
		}
		Start-Sleep -Milliseconds 100
	}
	$oldMoved = $false
	$newMoved = $false
	$child = $null
	try {
		$script:failureCode = 'UPDATE_START'
		Move-WithRetry $script:job.installDir $script:job.backupDir
		$oldMoved = $true
		Move-WithRetry $script:job.stageDir $script:job.installDir
		$newMoved = $true
		$script:failureCode = 'UPDATE_START'
		$child = Launch-Application $true
		$script:failureCode = 'UPDATE_ACK_TIMEOUT'
		$deadline = [DateTime]::UtcNow.AddMilliseconds($script:job.timeoutMs)
		while ($true) {
			if (Test-Path -LiteralPath $script:job.ackFile -PathType Leaf) {
				Assert-NoReparse $script:job.ackFile
				if ([IO.File]::ReadAllText($script:job.ackFile) -ceq $script:job.token) {
					try { [IO.File]::Delete($script:job.archivePath) } catch {}
					Write-Status 'succeeded' ''
					return
				}
			}
			if ($child.HasExited) { Fail 'UPDATE_START' 'The new application exited before ACK' }
			if ([DateTime]::UtcNow -ge $deadline) {
				Fail 'UPDATE_ACK_TIMEOUT' 'The new application did not confirm a healthy startup'
			}
			Start-Sleep -Milliseconds 50
		}
	} catch {
		$code = $script:failureCode
		try {
			if ($null -ne $child -and -not $child.HasExited) {
				& "$env:SystemRoot\System32\taskkill.exe" /PID $child.Id /T /F 2>$null | Out-Null
			}
			if ($newMoved) { Move-WithRetry $script:job.installDir $script:job.stageDir }
			if ($oldMoved) { Move-WithRetry $script:job.backupDir $script:job.installDir }
			Write-Status 'rolled-back' $code
			$restarted = Launch-Application $false
		} catch {
			$script:failureCode = 'UPDATE_ROLLBACK'
			Write-Status 'failed' $script:failureCode
			throw
		}
	}
}

try {
	$script:job = Read-Job
	if ($Prepare) {
		Expand-Application
	} else {
		Install-Application
	}
} catch {
	try { Write-Status 'failed' $script:failureCode } catch {}
	[Console]::Error.WriteLine($_.Exception.Message)
	exit 1
}

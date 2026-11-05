param([string]$Archive, [string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$base = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $total = [long]0
  if ($zip.Entries.Count -gt 20000) { throw 'Too many archive entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    if ($name.Contains(':') -or $name.StartsWith('\') -or $name.Split('\').Contains('..')) { throw 'Unsafe archive path' }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($base, $name))
    if (-not $target.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive escaped destination' }
    if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Archive symlink rejected' }
    $total += $entry.Length
    if ($total -gt 1073741824) { throw 'Archive expanded size exceeded' }
  }
} finally { $zip.Dispose() }
[IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)

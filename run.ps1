param(
  [Parameter(Mandatory = $true)]
  [string]$Script
)
$p = $env:HERDR_PLUGIN_ROOT
if ([string]::IsNullOrEmpty($p)) { $p = $PSScriptRoot }
if ($p.StartsWith('\\?\')) { $p = $p.Substring(4) }
$js = Join-Path $p $Script
& node $js @args
exit $LASTEXITCODE

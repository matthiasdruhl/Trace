param(
    [string]$StackName = "trace-eval",
    [string]$Region = "us-east-1",
    [string]$FrontendDir = "demo-ui"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repoRoot = Split-Path -Parent $PSScriptRoot
$frontendPath = Join-Path $repoRoot $FrontendDir
$distPath = Join-Path $frontendPath "dist"

if (-not (Test-Path $frontendPath)) {
    throw "Frontend directory not found: $frontendPath"
}

$stack = aws cloudformation describe-stacks `
    --stack-name $StackName `
    --region $Region `
    --query "Stacks[0]" | ConvertFrom-Json

$outputs = @{}
foreach ($entry in $stack.Outputs) {
    $outputs[$entry.OutputKey] = $entry.OutputValue
}

if (-not $outputs.ContainsKey("AppApiBaseUrl")) {
    throw "Stack output AppApiBaseUrl is missing. Deploy the full app stack first."
}

if (-not $outputs.ContainsKey("FrontendBucketName")) {
    throw "Stack output FrontendBucketName is missing. Deploy the full app stack first."
}

if (-not $outputs.ContainsKey("TraceAppDistributionId")) {
    throw "Stack output TraceAppDistributionId is missing. Deploy the full app stack first."
}

$env:VITE_TRACE_API_BASE_URL = $outputs["AppApiBaseUrl"]

Push-Location $frontendPath
try {
    npm.cmd run build
}
finally {
    Pop-Location
}

aws s3 sync $distPath "s3://$($outputs["FrontendBucketName"])/" --delete --region $Region | Out-Host
aws cloudfront create-invalidation `
    --distribution-id $outputs["TraceAppDistributionId"] `
    --paths "/*" `
    --region $Region | Out-Host

Write-Host ""
Write-Host "Frontend publish complete."
Write-Host "AppUrl: $($outputs["AppUrl"])"
Write-Host "AppApiBaseUrl: $($outputs["AppApiBaseUrl"])"

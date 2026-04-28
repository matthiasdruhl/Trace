param(
    [string]$StackName = "trace-eval",
    [string]$Region = "us-east-1",
    [string]$FrontendDir = "demo-ui",
    [switch]$SkipSmokeTest
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

function Invoke-NativeOrThrow {
    param(
        [Parameter(Mandatory = $true)]
        [string]$FilePath,
        [string[]]$Arguments = @()
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE."
    }
}

function Test-TraceAppDeployment {
    param(
        [Parameter(Mandatory = $true)]
        [string]$AppBaseUrl
    )

    $normalizedBaseUrl = $AppBaseUrl.TrimEnd("/")

    $rootResponse = Invoke-WebRequest -Uri $normalizedBaseUrl -Method Get
    if ($rootResponse.StatusCode -ne 200 -or $rootResponse.Content -notmatch "<html") {
        throw "Frontend root smoke test failed for $normalizedBaseUrl"
    }

    $healthResponse = Invoke-RestMethod -Uri "$normalizedBaseUrl/api/health" -Method Get
    if (-not $healthResponse.ok -or -not $healthResponse.ready) {
        throw "API health smoke test failed for $normalizedBaseUrl/api/health"
    }

    $searchBody = @{
        queryText = "recent vehicle inspection audit with overdue paperwork"
        filters = @{}
        limit = 3
    } | ConvertTo-Json -Depth 5

    $searchResponse = Invoke-RestMethod `
        -Uri "$normalizedBaseUrl/api/search" `
        -Method Post `
        -ContentType "application/json" `
        -Body $searchBody

    if (
        $null -eq $searchResponse.meta -or
        $null -eq $searchResponse.appliedFilter -or
        $null -eq $searchResponse.results
    ) {
        throw "API search smoke test returned an incomplete response from $normalizedBaseUrl/api/search"
    }
}

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
    Invoke-NativeOrThrow -FilePath "npm.cmd" -Arguments @("run", "build")
}
finally {
    Pop-Location
}

Invoke-NativeOrThrow `
    -FilePath "aws" `
    -Arguments @(
        "s3", "sync", $distPath, "s3://$($outputs["FrontendBucketName"])/",
        "--delete",
        "--region", $Region
    )

$invalidation = aws cloudfront create-invalidation `
    --distribution-id $outputs["TraceAppDistributionId"] `
    --paths "/*" `
    --region $Region | ConvertFrom-Json

if ($LASTEXITCODE -ne 0) {
    throw "aws cloudfront create-invalidation failed with exit code $LASTEXITCODE."
}

Invoke-NativeOrThrow `
    -FilePath "aws" `
    -Arguments @(
        "cloudfront", "wait", "invalidation-completed",
        "--distribution-id", $outputs["TraceAppDistributionId"],
        "--id", $invalidation.Invalidation.Id,
        "--region", $Region
    )

if (-not $SkipSmokeTest) {
    Test-TraceAppDeployment -AppBaseUrl $outputs["AppApiBaseUrl"]
}

Write-Host ""
Write-Host "Frontend publish complete."
Write-Host "AppUrl: $($outputs["AppUrl"])"
Write-Host "AppApiBaseUrl: $($outputs["AppApiBaseUrl"])"
if (-not $SkipSmokeTest) {
    Write-Host "Smoke test: passed"
}
